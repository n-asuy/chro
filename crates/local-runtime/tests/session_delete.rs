//! Deleting a session removes its conversation and the worktree only it uses,
//! and keeps its branch, its run logs, and any worktree another session works
//! in.

use std::path::{Path, PathBuf};
use std::process::Command;

use db::models::{ProjectRecord, TaskRecord, TaskRun};
use db::types::RunStatus;
use local_runtime::LocalRuntime;
use runtime::{Runtime, RuntimeOptions, TaskService};

const BRANCH: &str = "ch/doomed";

/// Each fixture points the process-wide worktree dir at its own sandbox.
static SANDBOX_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn git(dir: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("failed to spawn git")
        .status
        .success()
}

struct Fixture {
    temp: tempfile::TempDir,
    runtime: LocalRuntime,
    repo: PathBuf,
    worktree: PathBuf,
    project: ProjectRecord,
}

/// A project repo with a session worktree on its own branch, holding one
/// untracked file.
async fn session_worktree() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    std::env::set_var("CHRO_CONFIG_PATH", temp.path().join("config.json"));
    std::env::set_var("CHRO_WORKTREE_DIR", temp.path().join("worktrees"));

    let repo = temp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    for args in [
        &["init", "--initial-branch=main"][..],
        &["config", "user.email", "test@example.com"],
        &["config", "user.name", "test"],
    ] {
        assert!(git(&repo, args));
    }
    std::fs::write(repo.join("README.md"), "hello").unwrap();
    assert!(git(&repo, &["add", "."]));
    assert!(git(&repo, &["commit", "-m", "init"]));
    let worktree = temp.path().join("worktrees").join(BRANCH);
    assert!(git(
        &repo,
        &["worktree", "add", "-b", BRANCH, worktree.to_str().unwrap()]
    ));
    std::fs::write(worktree.join("notes.md"), "not committed").unwrap();

    let runtime = LocalRuntime::bootstrap(RuntimeOptions {
        user_id: "test-user".into(),
        db_path: Some(temp.path().join("test.db")),
    })
    .await
    .unwrap();
    let project =
        ProjectRecord::ensure_with_name_hint(runtime.db().pool(), repo.to_string_lossy().as_ref(), None)
            .await
            .unwrap();

    Fixture {
        temp,
        runtime,
        repo,
        worktree,
        project,
    }
}

/// A session whose finished run worked in `worktree` and left a run log.
async fn session_in(fixture: &Fixture, title: &str) -> (TaskRecord, PathBuf) {
    let pool = fixture.runtime.db().pool();
    let path = fixture.worktree.to_string_lossy().into_owned();
    let mut task = TaskRecord::new(fixture.project.id, title, None);
    task.branch = Some(BRANCH.into());
    task.worktree_path = Some(path.clone());
    task.insert(pool).await.unwrap();
    let mut run = TaskRun::new_local(task.id, None);
    run.branch_name = Some(BRANCH.into());
    run.container_ref = Some(path.clone());
    run.workspace_path = Some(path);
    run.status = RunStatus::Completed;
    run.insert(pool).await.unwrap();
    let log = fixture
        .temp
        .path()
        .join("logs")
        .join("runs")
        .join(format!("{}.jsonl", run.id));
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, "{\"Stdout\":\"hello\"}\n").unwrap();
    (task, log)
}

#[tokio::test]
async fn deleting_a_session_removes_its_own_worktree_and_keeps_the_branch() {
    let _env = SANDBOX_ENV.lock().await;
    let fixture = session_worktree().await;
    let (task, log) = session_in(&fixture, "doomed").await;
    let service = TaskService::new(&fixture.runtime);

    let plan = service.delete_plan(task.id).await.unwrap();
    assert_eq!(plan.branch.as_deref(), Some(BRANCH));
    assert_eq!(plan.worktrees, vec![fixture.worktree.to_string_lossy().into_owned()]);
    assert_eq!(plan.uncommitted_files, Some(1), "the untracked notes.md is lost with the worktree");

    service.delete_task(task.id).await.unwrap();

    assert!(!fixture.worktree.exists());
    assert!(
        git(&fixture.repo, &["rev-parse", "--verify", BRANCH]),
        "the branch outlives the session"
    );
    assert!(TaskRecord::find_by_id(fixture.runtime.db().pool(), task.id)
        .await
        .unwrap()
        .is_none());
    assert!(log.exists(), "the run log outlives the session");
}

#[tokio::test]
async fn deleting_a_session_keeps_a_worktree_another_session_works_in() {
    let _env = SANDBOX_ENV.lock().await;
    let fixture = session_worktree().await;
    let (doomed, _) = session_in(&fixture, "doomed").await;
    session_in(&fixture, "neighbour").await;
    let service = TaskService::new(&fixture.runtime);

    let plan = service.delete_plan(doomed.id).await.unwrap();
    assert!(plan.worktrees.is_empty());
    assert_eq!(plan.uncommitted_files, Some(0));

    service.delete_task(doomed.id).await.unwrap();

    assert!(
        fixture.worktree.join("notes.md").exists(),
        "the neighbour's worktree and its uncommitted work stay"
    );
}
