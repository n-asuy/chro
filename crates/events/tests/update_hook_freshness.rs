//! The DB change hook must broadcast the *committed* row, never the row as it
//! looked before the write it is reporting.
//!
//! The hook fires from inside the writing statement and then reads the row back
//! on a different pool connection. Under WAL that reader sees the last committed
//! snapshot, so a read that wins the race against the writer's commit publishes
//! the pre-update value — and because no further change fires for that row, the
//! stale value is the last word every subscriber ever gets.

use db::{
    models::{ProjectRecord, TaskRecord, TaskRun},
    types::RunStatus,
    DBService,
};
use events::{EventResources, EventService};
use json_patch::{Patch, PatchOperation};
use log_types::LogEntry;
use std::collections::HashMap;
use uuid::Uuid;

async fn setup() -> (EventService, DBService, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");

    let event_resources = EventResources::new();
    let hook_service = DBService::new_with_path(&db_path).await.unwrap();
    let hook = EventService::create_hook(&event_resources, hook_service);
    let db = DBService::new_with_path_and_hook(&db_path, hook)
        .await
        .unwrap();
    let event_service = EventService::new(db.clone(), event_resources);

    (event_service, db, temp_dir)
}

async fn create_project(db: &DBService, name: &str) -> ProjectRecord {
    let project = ProjectRecord::new(name, format!("/tmp/{name}"));
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
    project
}

/// Mirrors `mark_run_completion`: an autocommit UPDATE that moves a run to a
/// terminal status. This is the write whose broadcast the composer's Send/Stop
/// button depends on.
async fn complete_run(db: &DBService, run_id: Uuid) {
    sqlx::query(
        "UPDATE task_runs
         SET status = 'completed', exit_code = 0, completed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?",
    )
    .bind(run_id)
    .execute(db.pool())
    .await
    .unwrap();
}

/// The shape a real session has: one idle turn ending at a time, so every
/// completion wakes an idle publisher. Bursts hide this case because a backed-up
/// publisher is always reading well after the commit it is reporting.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_isolated_completion_is_broadcast_as_completed() {
    const TURNS: usize = 120;

    let (event_service, db, _temp_dir) = setup().await;
    let project = create_project(&db, "idle-completion").await;
    let task = TaskRecord::new(project.id, "idle completion", None);
    task.insert(db.pool()).await.unwrap();
    event_service.hydrate().await.unwrap();

    let mut receiver = event_service.msg_store().subscribe();
    let mut stale = Vec::new();

    for _ in 0..TURNS {
        let mut run = TaskRun::new_local(task.id, Some("turn".to_string()));
        run.status = RunStatus::Running;
        run.insert(db.pool()).await.unwrap();

        // Let the insert drain so the publisher is parked, exactly as it is
        // while an agent is working.
        tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;

        complete_run(&db, run.id).await;

        let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_millis(500);
        let mut last: Option<String> = None;
        while tokio::time::Instant::now() < deadline {
            let Ok(Ok(entry)) =
                tokio::time::timeout(tokio::time::Duration::from_millis(50), receiver.recv()).await
            else {
                if last.is_some() {
                    break;
                }
                continue;
            };
            for (id, status) in run_statuses(entry) {
                if id == run.id {
                    last = Some(status);
                }
            }
        }
        if last.as_deref() != Some("completed") {
            stale.push((run.id, last));
        }
    }

    assert!(
        stale.is_empty(),
        "{}/{} isolated completions were last broadcast stale: {:?}",
        stale.len(),
        TURNS,
        &stale[..stale.len().min(5)]
    );
}

/// Every `/task_runs/<id>` status carried by one broadcast entry.
fn run_statuses(entry: LogEntry) -> Vec<(Uuid, String)> {
    let LogEntry::JsonPatch(value) = entry else {
        return Vec::new();
    };
    let patch: Patch = serde_json::from_value(value).unwrap();
    let mut out = Vec::new();
    for op in patch.0 {
        let (path, value) = match op {
            PatchOperation::Add(op) => (op.path, op.value),
            PatchOperation::Replace(op) => (op.path, op.value),
            _ => continue,
        };
        let Some(id) = path.strip_prefix("/task_runs/") else {
            continue;
        };
        let Ok(id) = Uuid::parse_str(id) else {
            continue;
        };
        out.push((
            id,
            value
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("<missing>")
                .to_string(),
        ));
    }
    out
}

/// Before the hooks deferred publishing to the commit hook this failed on every
/// run under WAL, with 3-7% of the 300 completions published as still `running`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn completion_hook_never_broadcasts_a_stale_running_status() {
    const RUNS: usize = 300;

    let (event_service, db, _temp_dir) = setup().await;
    let project = create_project(&db, "hook-freshness").await;
    let task = TaskRecord::new(project.id, "hook freshness", None);
    task.insert(db.pool()).await.unwrap();
    event_service.hydrate().await.unwrap();

    let mut receiver = event_service.msg_store().subscribe();

    let mut run_ids = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let mut run = TaskRun::new_local(task.id, Some("stress".to_string()));
        run.status = RunStatus::Running;
        run.insert(db.pool()).await.unwrap();
        run_ids.push(run.id);
    }
    for run_id in &run_ids {
        complete_run(&db, *run_id).await;
    }

    // Drain until every run has been reported at least once, then a little
    // longer so a late-arriving patch can still overwrite an earlier one.
    let mut last_status: HashMap<Uuid, String> = HashMap::new();
    let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let Ok(Ok(entry)) = tokio::time::timeout(
            remaining.min(tokio::time::Duration::from_millis(500)),
            receiver.recv(),
        )
        .await
        else {
            if last_status.len() == RUNS {
                break;
            }
            continue;
        };
        let LogEntry::JsonPatch(value) = entry else {
            continue;
        };
        let patch: Patch = serde_json::from_value(value).unwrap();
        for op in patch.0 {
            let (path, value) = match op {
                PatchOperation::Add(op) => (op.path, op.value),
                PatchOperation::Replace(op) => (op.path, op.value),
                _ => continue,
            };
            let Some(id) = path.strip_prefix("/task_runs/") else {
                continue;
            };
            let Ok(id) = Uuid::parse_str(id) else {
                continue;
            };
            let status = value
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("<missing>")
                .to_string();
            last_status.insert(id, status);
        }
    }

    let stale: Vec<_> = run_ids
        .iter()
        .filter(|id| last_status.get(id).map(String::as_str) != Some("completed"))
        .map(|id| (*id, last_status.get(id).cloned()))
        .collect();

    assert!(
        stale.is_empty(),
        "{}/{} completed runs were last broadcast with a stale status: {:?}",
        stale.len(),
        RUNS,
        &stale[..stale.len().min(5)]
    );
}
