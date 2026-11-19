//! The phone's session list stream.
//!
//! The document is `{"tasks": {id: SessionListItem}, "counts": {project_id:
//! SessionCounts}}`. The first message sets both with the window's
//! sessions and every project's counts. After it, every change to a task is
//! forwarded as its item (a session that changed is the newest of its
//! project, so it belongs to any window), an archived or deleted session is
//! removed, and the counts that changed are rewritten in the same message.
//! A `remove` may name a session the subscriber never received; subscribers
//! treat that as a no-op.

use std::collections::BTreeMap;

use db::models::{SessionCounts, SessionListItem, SessionWindow, TaskRecord};
use futures::stream::BoxStream;
use json_patch::{AddOperation, Patch, PatchOperation, RemoveOperation, ReplaceOperation};
use log_types::LogEntry;
use serde_json::{Map, Value};
use sqlx::{Pool, Sqlite};
use tokio::sync::broadcast::{error::RecvError, Receiver};
use uuid::Uuid;

use crate::{escape_segment, parse_collection_patch, EventError, EventService};

type Counts = BTreeMap<Uuid, SessionCounts>;

impl EventService {
    /// Stream the phone's session list for `window`: a snapshot of the
    /// window, then live changes (see the module documentation).
    pub async fn stream_session_list_raw(
        &self,
        window: SessionWindow,
    ) -> Result<BoxStream<'static, Result<LogEntry, std::io::Error>>, EventError> {
        use futures::StreamExt;

        let pool = self.db.pool().clone();
        // Subscribe before the snapshot read so nothing falls in between.
        let rx = self.resources.msg_store.subscribe();
        let (initial, counts) = snapshot(&pool, &window).await?;
        let live = futures::stream::unfold(
            Live {
                rx,
                pool,
                window,
                counts,
            },
            Live::next,
        );
        Ok(futures::stream::once(async move { Ok(initial) })
            .chain(live)
            .boxed())
    }
}

/// The window's sessions and every project's counts, as one replacing patch.
async fn snapshot(
    pool: &Pool<Sqlite>,
    window: &SessionWindow,
) -> Result<(LogEntry, Counts), EventError> {
    let items = window.select(SessionListItem::list_live(pool).await?);
    let counts = SessionListItem::counts(pool).await?;
    let mut tasks = Map::new();
    for item in &items {
        tasks.insert(item.id.to_string(), serde_json::to_value(item)?);
    }
    let mut counts_value = Map::new();
    for (project_id, project_counts) in &counts {
        counts_value.insert(
            project_id.to_string(),
            serde_json::to_value(project_counts)?,
        );
    }
    // `add` sets a member whether or not it exists, so the snapshot applies
    // to a fresh document and replaces a previous connection's state alike.
    let entry = LogEntry::from(Patch(vec![
        PatchOperation::Add(AddOperation {
            path: "/tasks".into(),
            value: Value::Object(tasks),
        }),
        PatchOperation::Add(AddOperation {
            path: "/counts".into(),
            value: Value::Object(counts_value),
        }),
    ]));
    Ok((entry, counts))
}

struct Live {
    rx: Receiver<LogEntry>,
    pool: Pool<Sqlite>,
    window: SessionWindow,
    counts: Counts,
}

impl Live {
    async fn next(mut self) -> Option<(Result<LogEntry, std::io::Error>, Self)> {
        loop {
            match self.rx.recv().await {
                Ok(entry) => {
                    let Some(change) = task_change(&entry) else {
                        if matches!(entry, LogEntry::JsonPatch(_)) {
                            continue;
                        }
                        // Lifecycle entries pass through, as on the task streams.
                        return Some((Ok(entry), self));
                    };
                    let mut operations = vec![change];
                    match SessionListItem::counts(&self.pool).await {
                        Ok(counts) => {
                            operations.extend(counts_changes(&self.counts, &counts));
                            self.counts = counts;
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "session list counts unavailable; sent on the next change");
                        }
                    }
                    return Some((Ok(LogEntry::from(Patch(operations))), self));
                }
                Err(RecvError::Lagged(missed)) => {
                    // Missed changes cannot be recovered: start over from a snapshot.
                    tracing::warn!(
                        missed,
                        "session list stream lagged; resyncing from snapshot"
                    );
                    self.rx = self.rx.resubscribe();
                    let result = match snapshot(&self.pool, &self.window).await {
                        Ok((entry, counts)) => {
                            self.counts = counts;
                            Ok(entry)
                        }
                        Err(err) => Err(std::io::Error::other(err)),
                    };
                    return Some((result, self));
                }
                Err(RecvError::Closed) => return None,
            }
        }
    }
}

/// The session list operation for a hub entry that changes one task.
fn task_change(entry: &LogEntry) -> Option<PatchOperation> {
    let (operation, id) = parse_collection_patch(entry, "tasks")?;
    let path = format!("/tasks/{}", escape_segment(&id.to_string()));
    let value = match operation {
        PatchOperation::Add(AddOperation { value, .. })
        | PatchOperation::Replace(ReplaceOperation { value, .. }) => value,
        PatchOperation::Remove(_) => return Some(PatchOperation::Remove(RemoveOperation { path })),
        _ => return None,
    };
    let item = match serde_json::from_value::<TaskRecord>(value) {
        Ok(task) => SessionListItem::from(task),
        Err(err) => {
            tracing::warn!(%id, error = %err, "task change is not a task record; not sent to the session list");
            return None;
        }
    };
    Some(if item.is_archived() {
        PatchOperation::Remove(RemoveOperation { path })
    } else {
        PatchOperation::Add(AddOperation {
            path,
            value: serde_json::to_value(&item).ok()?,
        })
    })
}

/// Operations that turn `before` into `after` under `/counts`.
fn counts_changes(before: &Counts, after: &Counts) -> Vec<PatchOperation> {
    let path = |project_id: &Uuid| format!("/counts/{}", escape_segment(&project_id.to_string()));
    let mut operations: Vec<PatchOperation> = after
        .iter()
        .filter(|(project_id, counts)| before.get(project_id) != Some(counts))
        .filter_map(|(project_id, counts)| {
            Some(PatchOperation::Add(AddOperation {
                path: path(project_id),
                value: serde_json::to_value(counts).ok()?,
            }))
        })
        .collect();
    operations.extend(
        before
            .keys()
            .filter(|project_id| !after.contains_key(project_id))
            .map(|project_id| {
                PatchOperation::Remove(RemoveOperation {
                    path: path(project_id),
                })
            }),
    );
    operations
}

#[cfg(test)]
mod tests {
    use db::types::TaskStatus;
    use serde_json::json;

    use super::*;

    fn task_patch(operation: PatchOperation) -> LogEntry {
        LogEntry::from(Patch(vec![operation]))
    }

    fn record(status: TaskStatus) -> TaskRecord {
        let mut task = TaskRecord::new(Uuid::new_v4(), "A session", Some("long".repeat(1000)));
        task.status = status;
        task
    }

    #[test]
    fn a_changed_task_becomes_its_item() {
        let task = record(TaskStatus::Completed);
        let path = format!("/tasks/{}", task.id);
        for entry in [
            task_patch(PatchOperation::Add(AddOperation {
                path: path.clone(),
                value: serde_json::to_value(&task).unwrap(),
            })),
            task_patch(PatchOperation::Replace(ReplaceOperation {
                path: path.clone(),
                value: serde_json::to_value(&task).unwrap(),
            })),
        ] {
            let Some(PatchOperation::Add(add)) = task_change(&entry) else {
                panic!("expected an add")
            };
            assert_eq!(add.path, path);
            assert_eq!(
                add.value,
                serde_json::to_value(SessionListItem::from(task.clone())).unwrap(),
                "the item, without the description"
            );
        }
    }

    #[test]
    fn an_archived_or_deleted_task_leaves_the_list() {
        let task = record(TaskStatus::Cancelled);
        let path = format!("/tasks/{}", task.id);
        let archived = task_patch(PatchOperation::Replace(ReplaceOperation {
            path: path.clone(),
            value: serde_json::to_value(&task).unwrap(),
        }));
        let deleted = task_patch(PatchOperation::Remove(RemoveOperation {
            path: path.clone(),
        }));
        for entry in [archived, deleted] {
            assert!(
                matches!(task_change(&entry), Some(PatchOperation::Remove(ref remove)) if remove.path == path),
                "{entry:?}"
            );
        }
    }

    #[test]
    fn other_collections_and_other_entries_are_not_task_changes() {
        let run = task_patch(PatchOperation::Add(AddOperation {
            path: format!("/task_runs/{}", Uuid::new_v4()),
            value: json!({}),
        }));
        assert!(task_change(&run).is_none());
        assert!(task_change(&LogEntry::Finished).is_none());
    }

    #[test]
    fn counts_changes_rewrite_changed_projects_and_drop_gone_ones() {
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let before = Counts::from([
            (
                a,
                SessionCounts {
                    live: 1,
                    archived: 0,
                },
            ),
            (
                b,
                SessionCounts {
                    live: 2,
                    archived: 0,
                },
            ),
        ]);
        let after = Counts::from([
            (
                a,
                SessionCounts {
                    live: 1,
                    archived: 0,
                },
            ),
            (
                b,
                SessionCounts {
                    live: 1,
                    archived: 1,
                },
            ),
            (
                c,
                SessionCounts {
                    live: 1,
                    archived: 0,
                },
            ),
        ]);
        let operations = serde_json::to_value(Patch(counts_changes(&before, &after))).unwrap();
        let mut expected = vec![
            json!({"op": "add", "path": format!("/counts/{b}"), "value": {"live": 1, "archived": 1}}),
            json!({"op": "add", "path": format!("/counts/{c}"), "value": {"live": 1, "archived": 0}}),
        ];
        expected.sort_by_key(|operation| operation["path"].as_str().unwrap().to_string());
        assert_eq!(operations, Value::Array(expected));

        let gone = serde_json::to_value(Patch(counts_changes(&after, &Counts::new()))).unwrap();
        assert_eq!(gone.as_array().unwrap().len(), 3);
        assert!(gone
            .as_array()
            .unwrap()
            .iter()
            .all(|operation| operation["op"] == "remove"));
    }
}
