//! Per-turn exchange lookup for the hover preview's history rail.
//!
//! `task_session_exchange` must return the prompt and reply of the *requested*
//! turn — not the task's latest reply — and must refuse sessions that belong
//! to another task.

use chrono::{Duration, Utc};
use db::models::{AgentProfile, ProjectRecord, TaskRecord, TaskRun};
use local_runtime::LocalRuntime;
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

/// Insert a session row the way the runtime does on each send: one session per
/// user message, linked to the run that executed it. `age` pushes the row into
/// the past so created_at ordering between turns is deterministic.
async fn insert_session(
    runtime: &LocalRuntime,
    task_id: Uuid,
    run_id: Option<Uuid>,
    prompt: &str,
    age: Duration,
) -> Uuid {
    let session_id = Uuid::new_v4();
    let at = Utc::now() - age;
    let agent_profile_id = AgentProfile::ensure_default_desktop_profile(runtime.db().pool())
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO task_sessions (id, task_id, task_run_id, agent_profile_id, prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(task_id)
    .bind(run_id)
    .bind(agent_profile_id)
    .bind(prompt)
    .bind(at)
    .bind(at)
    .execute(runtime.db().pool())
    .await
    .unwrap();
    session_id
}

fn assistant_line(text: &str) -> String {
    format!(
        r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"{text}"}}]}}}}"#
    )
}

#[tokio::test]
async fn returns_the_requested_turn_not_the_latest() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = bootstrap_runtime(&temp).await;
    let task_id = insert_task(&runtime).await;

    let first_run = insert_run(&runtime, task_id).await;
    let second_run = insert_run(&runtime, task_id).await;
    let first_session = insert_session(
        &runtime,
        task_id,
        Some(first_run),
        "first prompt",
        Duration::minutes(10),
    )
    .await;
    let second_session = insert_session(
        &runtime,
        task_id,
        Some(second_run),
        "second prompt",
        Duration::minutes(5),
    )
    .await;

    runtime
        .append_stdout(first_run, assistant_line("first reply"))
        .await
        .unwrap();
    runtime
        .append_stdout(second_run, assistant_line("second reply"))
        .await
        .unwrap();

    let first = runtime
        .task_session_exchange(task_id, first_session)
        .await
        .unwrap()
        .expect("first session belongs to the task");
    assert_eq!(first.user.as_deref(), Some("first prompt"));
    assert_eq!(first.assistant.as_deref(), Some("first reply"));

    let second = runtime
        .task_session_exchange(task_id, second_session)
        .await
        .unwrap()
        .expect("second session belongs to the task");
    assert_eq!(second.user.as_deref(), Some("second prompt"));
    assert_eq!(second.assistant.as_deref(), Some("second reply"));
}

#[tokio::test]
async fn none_for_unknown_or_foreign_sessions() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = bootstrap_runtime(&temp).await;
    let task_id = insert_task(&runtime).await;
    let other_task_id = insert_task(&runtime).await;
    let foreign_session = insert_session(
        &runtime,
        other_task_id,
        None,
        "foreign prompt",
        Duration::minutes(1),
    )
    .await;

    assert!(runtime
        .task_session_exchange(task_id, Uuid::new_v4())
        .await
        .unwrap()
        .is_none());
    assert!(runtime
        .task_session_exchange(task_id, foreign_session)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn turn_without_run_or_reply_has_no_assistant() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = bootstrap_runtime(&temp).await;
    let task_id = insert_task(&runtime).await;

    let unlinked = insert_session(&runtime, task_id, None, "queued prompt", Duration::minutes(2))
        .await;
    let silent_run = insert_run(&runtime, task_id).await;
    let silent = insert_session(
        &runtime,
        task_id,
        Some(silent_run),
        "silent prompt",
        Duration::minutes(1),
    )
    .await;

    let unlinked_exchange = runtime
        .task_session_exchange(task_id, unlinked)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unlinked_exchange.user.as_deref(), Some("queued prompt"));
    assert!(unlinked_exchange.assistant.is_none());

    let silent_exchange = runtime
        .task_session_exchange(task_id, silent)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(silent_exchange.user.as_deref(), Some("silent prompt"));
    assert!(silent_exchange.assistant.is_none());
}
