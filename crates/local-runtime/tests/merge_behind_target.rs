//! Merging a session whose target branch moved on must still land.
//!
//! With several sessions running in parallel the target branch advances while
//! a session works, so almost every merge used to be refused as "diverged" and
//! had to be preceded by a manual rebase. Merge now replays the branch onto the
//! target first; only a real conflict stops it.

use std::path::{Path, PathBuf};
use std::process::Command;

use db::models::{ProjectRecord, TaskRecord, TaskRun};
use local_runtime::LocalRuntime;
use runtime::{Runtime, RuntimeOptions, TaskService};

const BRANCH: &str = "ch/parallel";

/// Each fixture points the process-wide config and worktree dir at its own
/// sandbox.
static SANDBOX_ENV: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("failed to spawn git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn commit_file(dir: &Path, name: &str, contents: &str, message: &str) {
    std::fs::write(dir.join(name), contents).unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", message]);
}

struct Fixture {
    _temp: tempfile::TempDir,
    runtime: LocalRuntime,
    repo: PathBuf,
    worktree: PathBuf,
    run: TaskRun,
}

/// A project repo on `main` and a session worktree on its own branch with one
/// committed file. The caller then moves `main` on.
async fn session_on_branch() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    std::env::set_var("CHRO_CONFIG_PATH", temp.path().join("config.json"));
    std::env::set_var("CHRO_WORKTREE_DIR", temp.path().join("worktrees"));

    let repo = temp.path().join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "--initial-branch=main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "test"]);
    commit_file(&repo, "shared.md", "base\n", "init");

    let worktree = temp.path().join("worktrees").join("parallel");
    git(
        &repo,
        &["worktree", "add", "-b", BRANCH, worktree.to_str().unwrap()],
    );
    commit_file(&worktree, "session.md", "session work\n", "session work");

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
    let mut task = TaskRecord::new(project.id, "parallel", None);
    task.branch = Some(BRANCH.into());
    task.worktree_path = Some(worktree.to_string_lossy().into_owned());
    task.insert(pool).await.unwrap();

    let mut run = TaskRun::new_local(task.id, None);
    run.branch_name = Some(BRANCH.into());
    run.target_branch = Some("main".into());
    run.container_ref = Some(worktree.to_string_lossy().into_owned());
    run.insert(pool).await.unwrap();

    Fixture {
        _temp: temp,
        runtime,
        repo,
        worktree,
        run,
    }
}

#[tokio::test]
async fn merge_replays_a_branch_that_fell_behind_its_target() {
    let _env = SANDBOX_ENV.lock().await;
    let fixture = session_on_branch().await;
    commit_file(&fixture.repo, "other.md", "another session\n", "other session landed");

    let outcome = TaskService::new(&fixture.runtime)
        .merge_task_run(fixture.run.id, None)
        .await
        .expect("a branch that is only behind must merge without a manual rebase");

    assert_eq!(outcome.target_branch, "main");
    assert_eq!(git(&fixture.repo, &["rev-parse", "main"]), outcome.merge_commit);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("session.md")).unwrap(),
        "session work\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("other.md")).unwrap(),
        "another session\n",
        "the target's own progress must survive the merge"
    );
}

#[tokio::test]
async fn merge_replays_uncommitted_work_too() {
    let _env = SANDBOX_ENV.lock().await;
    let fixture = session_on_branch().await;
    commit_file(&fixture.repo, "other.md", "another session\n", "other session landed");
    std::fs::write(fixture.worktree.join("draft.md"), "not yet committed\n").unwrap();

    TaskService::new(&fixture.runtime)
        .merge_task_run(fixture.run.id, None)
        .await
        .expect("uncommitted work is snapshotted before the replay, not refused as dirty");

    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("draft.md")).unwrap(),
        "not yet committed\n"
    );
}

#[tokio::test]
async fn merge_stops_on_a_conflict_and_leaves_the_target_untouched() {
    let _env = SANDBOX_ENV.lock().await;
    let fixture = session_on_branch().await;
    commit_file(&fixture.worktree, "shared.md", "session edit\n", "session edit");
    commit_file(&fixture.repo, "shared.md", "target edit\n", "target edit");
    let target_before = git(&fixture.repo, &["rev-parse", "main"]);

    let result = TaskService::new(&fixture.runtime)
        .merge_task_run(fixture.run.id, None)
        .await;

    assert!(result.is_err(), "a conflicting replay must not land");
    assert_eq!(git(&fixture.repo, &["rev-parse", "main"]), target_before);
    assert_eq!(
        std::fs::read_to_string(fixture.repo.join("shared.md")).unwrap(),
        "target edit\n"
    );
}
