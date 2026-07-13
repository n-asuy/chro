//! Provisioning failures must land the run in a terminal state.
//!
//! Regression: a start request that failed (or was cancelled) after the task
//! and run rows existed left the run Pending forever — a zombie session with
//! no executor, no logs, and an in-progress task that survived restarts and
//! rendered as an empty conversation.

use std::path::Path;
use std::process::Command;

use db::models::{TaskRecord, TaskRun};
use db::types::{RunStatus, TaskStatus};
use local_runtime::LocalRuntime;
use runtime::{Runtime, RuntimeOptions, StartExecutionSessionParams, TaskService};
use uuid::Uuid;

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .expect("failed to spawn git");
    assert!(status.success(), "git {args:?} failed");
}

#[tokio::test]
async fn failed_provisioning_marks_run_and_task_failed() {
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

    let runtime = LocalRuntime::bootstrap(RuntimeOptions {
        user_id: "test-user".into(),
        db_path: Some(temp.path().join("test.db")),
    })
    .await
    .unwrap();

    // A worktree execution whose base branch does not exist fails during
    // provisioning, after the task and run rows have been created.
    let result = TaskService::new(&runtime)
        .start_execution_session(StartExecutionSessionParams {
            prompt: Some("do something".into()),
            workspace_path: repo.clone(),
            resume_session_id: None,
            force_new_attempt: None,
            task_id: None,
            executor_profile_id: None,
            image_ids: None,
            use_worktree: Some(true),
            target_branch: Some("branch-that-does-not-exist".into()),
            selected_skill_ids: Vec::new(),
            context_refs: Vec::new(),
        })
        .await;
    assert!(result.is_err(), "expected provisioning to fail");

    let pool = runtime.db().pool();
    let run_id: Uuid =
        sqlx::query_scalar("SELECT id FROM task_runs ORDER BY created_at DESC LIMIT 1")
            .fetch_one(pool)
            .await
            .unwrap();
    let run = TaskRun::find_by_id(pool, run_id).await.unwrap().unwrap();
    assert_eq!(
        run.status,
        RunStatus::Failed,
        "a run whose provisioning failed must not stay Pending"
    );
    assert!(run.completed_at.is_some());

    let task = TaskRecord::find_by_id(pool, run.task_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(task.active_session_id, None);
    assert!(!task.awaiting_input);
}
