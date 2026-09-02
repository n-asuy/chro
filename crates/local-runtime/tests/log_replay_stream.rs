//! Cold log replay must terminate with the protocol's `finished` marker.
//!
//! Clients treat that marker (or a clean close) as the only authoritative end
//! of a replay: it is what lets them distinguish "this run genuinely has no
//! (more) history" from a stream that died mid-replay and must be retried.
//! A replay that ends without it is treated as incomplete and never recorded
//! as the run's true history.

use db::models::{ProjectRecord, TaskRecord, TaskRun};
use futures::StreamExt;
use local_runtime::LocalRuntime;
use log_types::LogEntry;
use runtime::{Runtime, RuntimeOptions};
use uuid::Uuid;

async fn bootstrap_runtime(temp: &tempfile::TempDir) -> LocalRuntime {
    // Keep config side effects inside the test sandbox.
    std::env::set_var("CHRO_CONFIG_PATH", temp.path().join("config.json"));
    LocalRuntime::bootstrap(RuntimeOptions {
        user_id: "test-user".into(),
        db_path: Some(temp.path().join("test.db")),
    })
    .await
    .unwrap()
}

async fn insert_task(runtime: &LocalRuntime) -> Uuid {
    let project = ProjectRecord::ensure_with_name_hint(runtime.db().pool(), "/tmp/repo", None)
        .await
        .unwrap();
    let task = TaskRecord::new(project.id, "test task", None);
    task.insert(runtime.db().pool()).await.unwrap();
    task.id
}

async fn insert_run(runtime: &LocalRuntime, task_id: Uuid) -> Uuid {
    let run = TaskRun::new_local(task_id, None);
    run.insert(runtime.db().pool()).await.unwrap();
    run.id
}

async fn collect_replay(runtime: &LocalRuntime, run_id: Uuid) -> Vec<LogEntry> {
    runtime
        .stream_logs(run_id)
        .await
        .unwrap()
        .map(|result| result.unwrap())
        .collect()
        .await
}

#[tokio::test]
async fn empty_run_replay_ends_with_finished_marker() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = bootstrap_runtime(&temp).await;
    let task_id = insert_task(&runtime).await;
    let run_id = insert_run(&runtime, task_id).await;

    let entries = collect_replay(&runtime, run_id).await;

    assert!(
        matches!(entries.as_slice(), [LogEntry::Finished]),
        "a run with no persisted log must still replay to a finished marker, got {} entries",
        entries.len()
    );
}

#[tokio::test]
async fn persisted_run_replay_ends_with_finished_marker() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = bootstrap_runtime(&temp).await;
    let task_id = insert_task(&runtime).await;
    let run_id = insert_run(&runtime, task_id).await;

    runtime
        .append_stdout(
            run_id,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#,
        )
        .await
        .unwrap();

    let entries = collect_replay(&runtime, run_id).await;

    assert!(
        entries
            .iter()
            .any(|entry| matches!(entry, LogEntry::JsonPatch(_))),
        "normalized replay should contain at least one patch"
    );
    assert!(
        matches!(entries.last(), Some(LogEntry::Finished)),
        "replay must end with the finished marker"
    );
}
