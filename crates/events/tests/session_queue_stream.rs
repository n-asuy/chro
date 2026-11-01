//! A session's queue is part of what the app shows live: a message queued
//! from the composer, the terminal or by an agent must appear under the
//! session's composer without a reload, follow edits and reordering, and
//! leave it when it becomes a turn or is withdrawn.

use std::time::Duration;

use db::{
    models::{ProjectRecord, SessionQueueItem, TaskRecord},
    DBService,
};
use events::{EventResources, EventService};
use futures::{stream::BoxStream, StreamExt};
use json_patch::{Patch, PatchOperation};
use log_types::LogEntry;

async fn setup() -> (EventService, DBService, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let resources = EventResources::new();
    let hook_service = DBService::new_with_path(&db_path).await.unwrap();
    let hook = EventService::create_hook(&resources, hook_service);
    let db = DBService::new_with_path_and_hook(&db_path, hook)
        .await
        .unwrap();
    (EventService::new(db.clone(), resources), db, temp_dir)
}

async fn create_task(db: &DBService, title: &str) -> TaskRecord {
    let project = ProjectRecord::new(title, format!("/tmp/{title}"));
    sqlx::query(
        "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(project.id)
    .bind(&project.name)
    .bind(&project.git_repo_path)
    .bind(project.created_at)
    .bind(project.updated_at)
    .execute(db.pool())
    .await
    .unwrap();
    let task = TaskRecord::new(project.id, title, None);
    task.insert(db.pool()).await.unwrap();
    task
}

type Stream = BoxStream<'static, Result<LogEntry, std::io::Error>>;

async fn next_patch(stream: &mut Stream) -> Vec<PatchOperation> {
    loop {
        let entry = tokio::time::timeout(Duration::from_secs(5), stream.next())
            .await
            .expect("a patch within 5s")
            .expect("stream open")
            .expect("no stream error");
        if let LogEntry::JsonPatch(value) = entry {
            return serde_json::from_value::<Patch>(value).unwrap().0;
        }
    }
}

fn snapshot_ids(ops: &[PatchOperation]) -> Vec<String> {
    match ops {
        [PatchOperation::Replace(replace)] => {
            assert_eq!(replace.path, "/session_queue");
            replace.value.as_object().unwrap().keys().cloned().collect()
        }
        other => panic!("expected one snapshot replace, got {other:?}"),
    }
}

fn path_of(op: &PatchOperation) -> &str {
    match op {
        PatchOperation::Add(op) => &op.path,
        PatchOperation::Replace(op) => &op.path,
        PatchOperation::Remove(op) => &op.path,
        other => panic!("unexpected op {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_snapshot_holds_only_this_sessions_queue() {
    let (events, db, _dir) = setup().await;
    let mine = create_task(&db, "mine").await;
    let other = create_task(&db, "other").await;
    let (queued, _) = SessionQueueItem::enqueue(db.pool(), mine.id, "next", None)
        .await
        .unwrap();
    SessionQueueItem::enqueue(db.pool(), other.id, "elsewhere", None)
        .await
        .unwrap();
    events.hydrate().await.unwrap();

    let mut stream = events.stream_session_queue_raw(mine.id).await.unwrap();
    assert_eq!(
        snapshot_ids(&next_patch(&mut stream).await),
        vec![queued.id.to_string()]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queuing_and_taking_a_message_reach_the_session_live() {
    let (events, db, _dir) = setup().await;
    let task = create_task(&db, "live").await;
    let other = create_task(&db, "other").await;
    events.hydrate().await.unwrap();

    let mut stream = events.stream_session_queue_raw(task.id).await.unwrap();
    assert!(snapshot_ids(&next_patch(&mut stream).await).is_empty());

    // Another session's queue never reaches this stream.
    SessionQueueItem::enqueue(db.pool(), other.id, "elsewhere", None)
        .await
        .unwrap();
    let (item, _) = SessionQueueItem::enqueue(db.pool(), task.id, "next", None)
        .await
        .unwrap();
    let added = next_patch(&mut stream).await;
    assert!(
        matches!(added.as_slice(), [PatchOperation::Add(_)]),
        "{added:?}"
    );
    assert_eq!(path_of(&added[0]), format!("/session_queue/{}", item.id));
    if let PatchOperation::Add(add) = &added[0] {
        assert_eq!(add.value["prompt"], "next");
    }

    SessionQueueItem::remove(db.pool(), item.id).await.unwrap();
    let removed = next_patch(&mut stream).await;
    assert!(
        matches!(removed.as_slice(), [PatchOperation::Remove(_)]),
        "{removed:?}"
    );
    assert_eq!(path_of(&removed[0]), format!("/session_queue/{}", item.id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_message_queued_after_hydration_is_routed_to_its_session() {
    let (events, db, _dir) = setup().await;
    events.hydrate().await.unwrap();
    // The task exists only after hydration, so routing must learn it live.
    let task = create_task(&db, "late").await;
    let mut stream = events.stream_session_queue_raw(task.id).await.unwrap();
    next_patch(&mut stream).await;

    let (item, _) = SessionQueueItem::enqueue(db.pool(), task.id, "next", None)
        .await
        .unwrap();
    let added = next_patch(&mut stream).await;
    assert_eq!(path_of(&added[0]), format!("/session_queue/{}", item.id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_edit_or_a_new_order_reaches_the_session_live() {
    let (events, db, _dir) = setup().await;
    let task = create_task(&db, "mine").await;
    events.hydrate().await.unwrap();
    let mut stream = events.stream_session_queue_raw(task.id).await.unwrap();
    next_patch(&mut stream).await;

    let (first, _) = SessionQueueItem::enqueue(db.pool(), task.id, "one", None)
        .await
        .unwrap();
    next_patch(&mut stream).await;
    let (second, _) = SessionQueueItem::enqueue(db.pool(), task.id, "two", None)
        .await
        .unwrap();
    next_patch(&mut stream).await;

    SessionQueueItem::update_prompt(db.pool(), task.id, first.id, "one, revised")
        .await
        .unwrap();
    let edited = next_patch(&mut stream).await;
    assert_eq!(path_of(&edited[0]), format!("/session_queue/{}", first.id));
    if let PatchOperation::Replace(replace) = &edited[0] {
        assert_eq!(replace.value["prompt"], "one, revised");
    } else {
        panic!("expected a replace, got {edited:?}");
    }

    SessionQueueItem::move_to_front(db.pool(), task.id, second.id)
        .await
        .unwrap();
    let moved = next_patch(&mut stream).await;
    assert_eq!(path_of(&moved[0]), format!("/session_queue/{}", second.id));
    if let PatchOperation::Replace(replace) = &moved[0] {
        assert!(replace.value["seq"].as_i64().unwrap() < first.seq);
    } else {
        panic!("expected a replace, got {moved:?}");
    }
}
