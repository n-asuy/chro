//! The phone's session list stream against a real database and change hook:
//! the snapshot holds the window and the counts, and every committed change
//! arrives as one message that also rewrites the counts it changed.

use std::time::Duration;

use db::{
    models::{ProjectRecord, SessionSort, SessionWindow, TaskRecord},
    types::TaskStatus,
    DBService,
};
use events::{EventResources, EventService};
use futures::{stream::BoxStream, StreamExt};
use log_types::LogEntry;
use serde_json::{json, Value};

type Messages = BoxStream<'static, Result<LogEntry, std::io::Error>>;

async fn setup() -> (EventService, DBService, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let resources = EventResources::new();
    let hook = EventService::create_hook(
        &resources,
        DBService::new_with_path(&db_path).await.unwrap(),
    );
    let db = DBService::new_with_path_and_hook(&db_path, hook)
        .await
        .unwrap();
    (EventService::new(db.clone(), resources), db, temp_dir)
}

async fn project(db: &DBService, name: &str) -> ProjectRecord {
    ProjectRecord::ensure_with_name_hint(db.pool(), &format!("/tmp/{name}"), Some(name))
        .await
        .unwrap()
}

async fn task(db: &DBService, project: &ProjectRecord, title: &str) -> TaskRecord {
    let task = TaskRecord::new(project.id, title, Some("description ".repeat(500)));
    task.insert(db.pool()).await.unwrap();
    task
}

async fn next_patch(stream: &mut Messages) -> Value {
    let entry = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("a message")
        .expect("the stream is open")
        .expect("no error");
    match entry {
        LogEntry::JsonPatch(patch) => patch,
        other => panic!("expected a patch, got {other:?}"),
    }
}

fn window(per_project: usize) -> SessionWindow {
    SessionWindow {
        per_project,
        recent: 0,
        ..SessionWindow::new(SessionSort::Recent)
    }
}

#[tokio::test]
async fn the_snapshot_holds_the_window_and_every_projects_counts() {
    let (events, db, _dir) = setup().await;
    let repo = project(&db, "repo").await;
    let older = task(&db, &repo, "older").await;
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let newer = task(&db, &repo, "newer").await;
    let archived = task(&db, &repo, "archived").await;
    TaskRecord::update_status(db.pool(), archived.id, TaskStatus::Cancelled)
        .await
        .unwrap();

    let mut stream = events.stream_session_list_raw(window(1)).await.unwrap();
    let snapshot = next_patch(&mut stream).await;

    assert_eq!(snapshot[0]["op"], "add");
    assert_eq!(snapshot[0]["path"], "/tasks");
    let tasks = snapshot[0]["value"].as_object().unwrap();
    assert_eq!(
        tasks.keys().collect::<Vec<_>>(),
        vec![&newer.id.to_string()],
        "{older:?} is outside"
    );
    assert!(tasks[&newer.id.to_string()].get("description").is_none());
    assert_eq!(snapshot[1]["path"], "/counts");
    assert_eq!(
        snapshot[1]["value"][repo.id.to_string()],
        json!({"live": 2, "archived": 1})
    );
}

/// Applies messages to `document` until `done` holds for it.
async fn fold_until(stream: &mut Messages, document: &mut Value, done: impl Fn(&Value) -> bool) {
    while !done(document) {
        let patch: json_patch::Patch = serde_json::from_value(next_patch(stream).await).unwrap();
        // A remove of a session this subscriber never held is a no-op.
        for operation in patch.0 {
            if let json_patch::PatchOperation::Remove(remove) = &operation {
                if document.pointer(&remove.path).is_none() {
                    continue;
                }
            }
            json_patch::patch(document, &[operation]).unwrap();
        }
    }
}

#[tokio::test]
async fn changes_arrive_as_items_and_keep_the_counts_current() {
    let (events, db, _dir) = setup().await;
    let repo = project(&db, "repo").await;
    let first = task(&db, &repo, "first").await;
    let mut stream = events.stream_session_list_raw(window(10)).await.unwrap();
    let mut document = json!({});
    fold_until(&mut stream, &mut document, |doc| doc.get("tasks").is_some()).await;
    let counts = format!("/counts/{}", repo.id);
    let item = |task: &TaskRecord| format!("/tasks/{}", task.id);

    let second = task(&db, &repo, "second").await;
    fold_until(&mut stream, &mut document, |doc| {
        doc.pointer(&item(&second)).is_some()
            && doc.pointer(&counts) == Some(&json!({"live": 2, "archived": 0}))
    })
    .await;
    assert_eq!(document.pointer(&item(&second)).unwrap()["title"], "second");
    assert!(document
        .pointer(&item(&second))
        .unwrap()
        .get("description")
        .is_none());

    TaskRecord::update_title(db.pool(), first.id, "renamed".into(), None)
        .await
        .unwrap();
    fold_until(&mut stream, &mut document, |doc| {
        doc.pointer(&format!("{}/title", item(&first))) == Some(&json!("renamed"))
    })
    .await;

    TaskRecord::update_status(db.pool(), first.id, TaskStatus::Cancelled)
        .await
        .unwrap();
    fold_until(&mut stream, &mut document, |doc| {
        doc.pointer(&item(&first)).is_none()
            && doc.pointer(&counts) == Some(&json!({"live": 1, "archived": 1}))
    })
    .await;

    TaskRecord::update_status(db.pool(), first.id, TaskStatus::Pending)
        .await
        .unwrap();
    fold_until(&mut stream, &mut document, |doc| {
        doc.pointer(&item(&first)).is_some()
            && doc.pointer(&counts) == Some(&json!({"live": 2, "archived": 0}))
    })
    .await;
}
