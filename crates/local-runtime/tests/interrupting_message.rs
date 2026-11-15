//! A message sent with `WhenBusy::Interrupt` stops the turn in flight and runs
//! next, ahead of the messages already waiting, which keep their order.

use db::models::{ProjectRecord, SessionQueueItem, TaskRecord, TaskRun};
use db::types::RunStatus;
use local_runtime::LocalRuntime;
use runtime::{Runtime, RuntimeOptions, SendTaskMessageParams, TaskService, WhenBusy};

#[tokio::test]
async fn an_interrupting_message_stops_the_turn_and_goes_ahead_of_the_queue() {
    let temp = tempfile::tempdir().unwrap();
    // Keep config and worktree side effects inside the test sandbox.
    std::env::set_var("CHRO_CONFIG_PATH", temp.path().join("config.json"));
    std::env::set_var("CHRO_WORKTREE_DIR", temp.path().join("worktrees"));
    let runtime = LocalRuntime::bootstrap(RuntimeOptions {
        user_id: "test-user".into(),
        db_path: Some(temp.path().join("test.db")),
    })
    .await
    .unwrap();
    let pool = runtime.db().pool();

    // A busy session: one turn in flight and one message waiting behind it.
    // Its project folder does not exist, so no agent can start in this test.
    let missing = temp.path().join("missing-project");
    let project =
        ProjectRecord::ensure_with_name_hint(pool, missing.to_string_lossy().as_ref(), None)
            .await
            .unwrap();
    let task = TaskRecord::new(project.id, "busy", None);
    task.insert(pool).await.unwrap();
    let turn = TaskRun::new_local(task.id, None);
    turn.insert(pool).await.unwrap();
    let service = TaskService::new(&runtime);
    service
        .deliver(
            SendTaskMessageParams::text(task.id, "earlier".into()),
            WhenBusy::Queue,
        )
        .await
        .unwrap();

    let delivered = service
        .deliver(
            SendTaskMessageParams::text(task.id, "redirect".into()),
            WhenBusy::Interrupt,
        )
        .await;
    assert!(delivered.is_err(), "no agent can start here: {delivered:?}");

    let stopped = TaskRun::find_by_id(pool, turn.id).await.unwrap().unwrap();
    assert_ne!(
        stopped.status,
        RunStatus::Pending,
        "the turn in flight is stopped"
    );
    let waiting: Vec<String> = SessionQueueItem::list_by_task(pool, task.id)
        .await
        .unwrap()
        .into_iter()
        .map(|item| item.prompt)
        .collect();
    // The start failed, so the interrupting message stays at the head for the
    // next attempt; the message that was already waiting keeps its place.
    assert_eq!(waiting, ["redirect", "earlier"]);
}
