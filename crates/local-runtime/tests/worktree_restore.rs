//! A session whose worktree was reclaimed must stay resumable.
//!
//! Regression: housekeeping reclaimed a worktree shared by many sessions while
//! one of them was still in use, and every session on it was left with no
//! workspace to resume in. The branch survives cleanup, so resuming rebuilds
//! the worktree from it.

use std::path::Path;
use std::process::Command;

use db::models::{ProjectRecord, TaskRecord, TaskRun};
use local_runtime::LocalRuntime;
use runtime::{Runtime, RuntimeOptions, TaskService};

const BRANCH: &str = "ch/reclaimed";

/// Each fixture points the process-wide worktree dir at its own sandbox.
static SANDBOX_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {args:?} failed");
}

struct Fixture {
    _temp: tempfile::TempDir,
    runtime: LocalRuntime,
    project: ProjectRecord,
    task: TaskRecord,
}

/// A project repo whose session branch carries one committed file, with the
/// branch no longer checked out anywhere (its worktree was reclaimed).
async fn reclaimed_session() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    // Keep config and worktree side effects inside the test sandbox.
    std::env::set_var("CHRO_CONFIG_PATH", temp.path().join("config.json"));
    std::env::set_var("CHRO_WORKTREE_DIR", temp.path().join("worktrees"));

    let repo = temp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "--initial-branch=main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "test"]);
    std::fs::write(repo.join("README.md"), "hello").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "init"]);
    git(&repo, &["checkout", "-b", BRANCH]);
    std::fs::write(repo.join("work.md"), "session work").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-m", "session work"]);
    git(&repo, &["checkout", "main"]);

    let runtime = LocalRuntime::bootstrap(RuntimeOptions {
        user_id: "test-user".into(),
        db_path: Some(temp.path().join("test.db")),
    })
    .await
    .unwrap();
    let pool = runtime.db().pool();
    let project = ProjectRecord::ensure_with_name_hint(pool, repo.to_string_lossy().as_ref(), None)
        .await
        .unwrap();
    let mut task = TaskRecord::new(project.id, "reclaimed", None);
    task.branch = Some(BRANCH.into());
    task.worktree_deleted = true;
    task.insert(pool).await.unwrap();

    Fixture {
        _temp: temp,
        runtime,
        project,
        task,
    }
}

fn reclaimed_run(task: &TaskRecord, recorded: Option<&Path>) -> TaskRun {
    let mut run = TaskRun::new_local(task.id, None);
    run.branch_name = Some(BRANCH.into());
    run.target_branch = Some("main".into());
    run.container_ref = recorded.map(|path| path.to_string_lossy().into_owned());
    run.worktree_deleted = true;
    run
}

async fn assert_restored(fixture: &Fixture, run: TaskRun) {
    let pool = fixture.runtime.db().pool();
    run.insert(pool).await.unwrap();

    let workspace = TaskService::new(&fixture.runtime)
        .ensure_run_workspace(&run, &fixture.project)
        .await
        .expect("a reclaimed worktree must be rebuilt from its branch");

    assert_eq!(
        std::fs::read_to_string(workspace.join("work.md")).unwrap(),
        "session work",
        "the rebuilt worktree must carry the session's committed work"
    );
    let task = TaskRecord::get(pool, fixture.task.id).await.unwrap();
    assert_eq!(
        task.worktree_path.as_deref(),
        Some(workspace.to_string_lossy().as_ref()),
        "the rebuilt worktree must be registered back on the task"
    );
    assert!(!task.worktree_deleted);
}

#[tokio::test]
async fn a_run_whose_recorded_worktree_was_removed_is_rebuilt() {
    let _env = SANDBOX_ENV.lock().await;
    let fixture = reclaimed_session().await;
    let gone = fixture._temp.path().join("worktrees").join(BRANCH);
    assert!(!gone.exists());

    assert_restored(&fixture, reclaimed_run(&fixture.task, Some(&gone))).await;
}

#[tokio::test]
async fn a_run_with_no_recorded_workspace_is_rebuilt_from_its_branch() {
    let _env = SANDBOX_ENV.lock().await;
    let fixture = reclaimed_session().await;

    assert_restored(&fixture, reclaimed_run(&fixture.task, None)).await;
}
