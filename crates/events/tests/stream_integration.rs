use db::{
    models::{AgentProfile, ProjectRecord, TaskDraft, TaskRecord, TaskRun, TaskSession},
    DBService,
};
use events::{EventResources, EventService};
use futures::StreamExt;
use json_patch::Patch;
use log_types::LogEntry;
use uuid::Uuid;

/// Insert a task draft using raw SQL (model lacks insert method)
async fn insert_draft(db: &DBService, draft: &TaskDraft) {
    sqlx::query(
        "INSERT INTO task_drafts (id, task_id, retry_task_run_id, draft_type, prompt, image_ids, queued, sending, version, variant, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(draft.id)
    .bind(draft.task_id)
    .bind(draft.retry_task_run_id)
    .bind(draft.draft_type)
    .bind(&draft.prompt)
    .bind(&draft.image_ids)
    .bind(draft.queued as i32)
    .bind(draft.sending as i32)
    .bind(draft.version)
    .bind(&draft.variant)
    .bind(draft.created_at)
    .bind(draft.updated_at)
    .execute(db.pool())
    .await
    .unwrap();
}

async fn insert_session(db: &DBService, session: &TaskSession) {
    sqlx::query(
        "INSERT INTO task_sessions (id, task_id, task_run_id, agent_profile_id, external_session_id, prompt, summary, handoff_from_session_id, worktree_commit, state_snapshot, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(session.id)
    .bind(session.task_id)
    .bind(session.task_run_id)
    .bind(session.agent_profile_id)
    .bind(&session.external_session_id)
    .bind(&session.prompt)
    .bind(&session.summary)
    .bind(session.handoff_from_session_id)
    .bind(&session.worktree_commit)
    .bind(&session.state_snapshot)
    .bind(session.created_at)
    .bind(session.updated_at)
    .execute(db.pool())
    .await
    .unwrap();
}

/// Create a fresh test database in a temp directory
/// Returns the DBService and TempDir (kept alive to prevent cleanup)
async fn setup_test_db() -> (DBService, tempfile::TempDir) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");
    let db = DBService::new_with_path(&db_path).await.unwrap();
    (db, temp_dir)
}

/// Create an EventService with a test database
async fn setup_event_service() -> (EventService, DBService, tempfile::TempDir) {
    let (db, temp_dir) = setup_test_db().await;
    let resources = EventResources::new();
    let event_service = EventService::new(db.clone(), resources);
    (event_service, db, temp_dir)
}

/// Create a test project
async fn create_project(db: &DBService, name: &str) -> ProjectRecord {
    let project = ProjectRecord::new(name, format!("/tmp/{}", name));
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

/// Create a test task
async fn create_task(db: &DBService, project_id: Uuid, title: &str) -> TaskRecord {
    let task = TaskRecord::new(project_id, title, None);
    task.insert(db.pool()).await.unwrap();
    task
}

#[tokio::test]
async fn stream_tasks_returns_initial_snapshot() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "test-project").await;
    let task1 = create_task(&db, project.id, "Task 1").await;
    let task2 = create_task(&db, project.id, "Task 2").await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_tasks_raw(project.id).await.unwrap();

    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        assert_eq!(patch.0.len(), 1);

        let op = &patch.0[0];
        match op {
            json_patch::PatchOperation::Replace(replace_op) => {
                assert_eq!(replace_op.path, "/tasks");

                let tasks_obj = replace_op.value.as_object().unwrap();
                assert!(tasks_obj.contains_key(&task1.id.to_string()));
                assert!(tasks_obj.contains_key(&task2.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_tasks_filters_by_project() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project_a = create_project(&db, "project-a").await;
    let project_b = create_project(&db, "project-b").await;

    let task_a = create_task(&db, project_a.id, "Task A").await;
    let _task_b = create_task(&db, project_b.id, "Task B").await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_tasks_raw(project_a.id).await.unwrap();

    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        let op = &patch.0[0];

        match op {
            json_patch::PatchOperation::Replace(replace_op) => {
                let tasks_obj = replace_op.value.as_object().unwrap();
                assert_eq!(tasks_obj.len(), 1);
                assert!(tasks_obj.contains_key(&task_a.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_task_runs_returns_initial_snapshot() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "runs-project").await;
    let task = create_task(&db, project.id, "Task with Runs").await;

    let run = TaskRun::new_local(task.id, Some("test run".to_string()));
    run.insert(db.pool()).await.unwrap();

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_task_runs_raw(task.id).await.unwrap();

    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        assert_eq!(patch.0.len(), 1);

        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                assert_eq!(replace_op.path, "/task_runs");
                let runs_obj = replace_op.value.as_object().unwrap();
                assert!(runs_obj.contains_key(&run.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_task_runs_filters_by_task() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "multi-task-project").await;
    let task_a = create_task(&db, project.id, "Task A").await;
    let task_b = create_task(&db, project.id, "Task B").await;

    let run_a = TaskRun::new_local(task_a.id, Some("run A".to_string()));
    run_a.insert(db.pool()).await.unwrap();

    let run_b = TaskRun::new_local(task_b.id, Some("run B".to_string()));
    run_b.insert(db.pool()).await.unwrap();

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_task_runs_raw(task_a.id).await.unwrap();

    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                let runs_obj = replace_op.value.as_object().unwrap();
                assert_eq!(runs_obj.len(), 1);
                assert!(runs_obj.contains_key(&run_a.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_task_sessions_returns_initial_snapshot() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "sessions-project").await;
    let task = create_task(&db, project.id, "Task with Sessions").await;
    let run = TaskRun::new_local(task.id, Some("test run".to_string()));
    run.insert(db.pool()).await.unwrap();

    let agent_id = AgentProfile::ensure_default_desktop_profile(db.pool())
        .await
        .unwrap();
    let session = TaskSession::new(task.id, agent_id, Some("Follow up".to_string()));
    let mut session = session;
    session.task_run_id = Some(run.id);
    insert_session(&db, &session).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service
        .stream_task_sessions_raw(task.id)
        .await
        .unwrap();
    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        assert_eq!(patch.0.len(), 1);

        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                assert_eq!(replace_op.path, "/task_sessions");
                let sessions_obj = replace_op.value.as_object().unwrap();
                assert!(sessions_obj.contains_key(&session.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_task_sessions_filters_by_task() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "multi-session-project").await;
    let task_a = create_task(&db, project.id, "Task A").await;
    let task_b = create_task(&db, project.id, "Task B").await;

    let run_a = TaskRun::new_local(task_a.id, Some("run A".to_string()));
    run_a.insert(db.pool()).await.unwrap();
    let run_b = TaskRun::new_local(task_b.id, Some("run B".to_string()));
    run_b.insert(db.pool()).await.unwrap();

    let agent_id = AgentProfile::ensure_default_desktop_profile(db.pool())
        .await
        .unwrap();

    let mut session_a = TaskSession::new(task_a.id, agent_id, Some("Prompt A".to_string()));
    session_a.task_run_id = Some(run_a.id);
    insert_session(&db, &session_a).await;

    let mut session_b = TaskSession::new(task_b.id, agent_id, Some("Prompt B".to_string()));
    session_b.task_run_id = Some(run_b.id);
    insert_session(&db, &session_b).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service
        .stream_task_sessions_raw(task_a.id)
        .await
        .unwrap();
    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                let sessions_obj = replace_op.value.as_object().unwrap();
                assert_eq!(sessions_obj.len(), 1);
                assert!(sessions_obj.contains_key(&session_a.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_task_drafts_returns_initial_snapshot() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "drafts-project").await;
    let task = create_task(&db, project.id, "Task with Drafts").await;

    let draft = TaskDraft::new_initial(task.id, Some("Draft content".to_string()));
    insert_draft(&db, &draft).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service
        .stream_task_drafts_raw(project.id)
        .await
        .unwrap();

    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        assert_eq!(patch.0.len(), 1);

        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                assert_eq!(replace_op.path, "/task_drafts");
                let drafts_obj = replace_op.value.as_object().unwrap();
                assert!(drafts_obj.contains_key(&draft.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_task_drafts_filters_by_project() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project_a = create_project(&db, "drafts-project-a").await;
    let project_b = create_project(&db, "drafts-project-b").await;

    let task_a = create_task(&db, project_a.id, "Task A").await;
    let task_b = create_task(&db, project_b.id, "Task B").await;

    let draft_a = TaskDraft::new_initial(task_a.id, Some("Draft A".to_string()));
    insert_draft(&db, &draft_a).await;

    let draft_b = TaskDraft::new_initial(task_b.id, Some("Draft B".to_string()));
    insert_draft(&db, &draft_b).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service
        .stream_task_drafts_raw(project_a.id)
        .await
        .unwrap();

    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                let drafts_obj = replace_op.value.as_object().unwrap();
                assert_eq!(drafts_obj.len(), 1);
                assert!(drafts_obj.contains_key(&draft_a.id.to_string()));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_tasks_empty_project_returns_empty_snapshot() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "empty-project").await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_tasks_raw(project.id).await.unwrap();

    let first_msg = stream.next().await.expect("expected initial snapshot");
    let msg = first_msg.unwrap();

    if let LogEntry::JsonPatch(patch_value) = msg {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                let tasks_obj = replace_op.value.as_object().unwrap();
                assert!(tasks_obj.is_empty());
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected JsonPatch message");
    }
}

#[tokio::test]
async fn stream_tasks_passes_remove_operations() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "remove-test-project").await;
    let task = create_task(&db, project.id, "Task to Remove").await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_tasks_raw(project.id).await.unwrap();

    let _ = stream.next().await;

    let remove_patch = json_patch::Patch(vec![json_patch::PatchOperation::Remove(
        json_patch::RemoveOperation {
            path: format!("/tasks/{}", task.id),
        },
    )]);
    event_service.msg_store().push_patch(remove_patch);

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), stream.next()).await;

    if let Ok(Some(Ok(LogEntry::JsonPatch(patch_value)))) = received {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        assert_eq!(patch.0.len(), 1);

        match &patch.0[0] {
            json_patch::PatchOperation::Remove(remove_op) => {
                assert_eq!(remove_op.path, format!("/tasks/{}", task.id));
            }
            _ => panic!("expected Remove operation"),
        }
    } else {
        panic!("expected to receive remove patch");
    }
}

#[tokio::test]
async fn stream_filters_add_operations_by_project() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project_a = create_project(&db, "filter-project-a").await;
    let project_b = create_project(&db, "filter-project-b").await;

    let task_b = create_task(&db, project_b.id, "Task B").await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_tasks_raw(project_a.id).await.unwrap();

    let _ = stream.next().await;

    let add_patch = json_patch::Patch(vec![json_patch::PatchOperation::Add(
        json_patch::AddOperation {
            path: format!("/tasks/{}", task_b.id),
            value: serde_json::to_value(&task_b).unwrap(),
        },
    )]);
    event_service.msg_store().push_patch(add_patch);

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(200), stream.next()).await;

    assert!(
        received.is_err(),
        "should not receive patches for other projects"
    );
}

#[tokio::test]
async fn multiple_streams_receive_same_updates() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "multi-stream-project").await;
    let task = create_task(&db, project.id, "Shared Task").await;

    event_service.hydrate().await.unwrap();

    let mut stream1 = event_service.stream_tasks_raw(project.id).await.unwrap();
    let mut stream2 = event_service.stream_tasks_raw(project.id).await.unwrap();

    let msg1 = stream1.next().await.unwrap().unwrap();
    let msg2 = stream2.next().await.unwrap().unwrap();

    if let (LogEntry::JsonPatch(p1), LogEntry::JsonPatch(p2)) = (msg1, msg2) {
        let patch1: Patch = serde_json::from_value(p1).unwrap();
        let patch2: Patch = serde_json::from_value(p2).unwrap();

        match (&patch1.0[0], &patch2.0[0]) {
            (json_patch::PatchOperation::Replace(r1), json_patch::PatchOperation::Replace(r2)) => {
                assert!(r1
                    .value
                    .as_object()
                    .unwrap()
                    .contains_key(&task.id.to_string()));
                assert!(r2
                    .value
                    .as_object()
                    .unwrap()
                    .contains_key(&task.id.to_string()));
            }
            _ => panic!("expected Replace operations"),
        }
    } else {
        panic!("expected JsonPatch messages");
    }
}

#[tokio::test]
async fn stream_task_runs_passes_remove_operations() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "runs-remove-project").await;
    let task = create_task(&db, project.id, "Task with Runs").await;

    let run = TaskRun::new_local(task.id, Some("test run".to_string()));
    run.insert(db.pool()).await.unwrap();

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_task_runs_raw(task.id).await.unwrap();

    let _ = stream.next().await;

    let remove_patch = json_patch::Patch(vec![json_patch::PatchOperation::Remove(
        json_patch::RemoveOperation {
            path: format!("/task_runs/{}", run.id),
        },
    )]);
    event_service.msg_store().push_patch(remove_patch);

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), stream.next()).await;

    if let Ok(Some(Ok(LogEntry::JsonPatch(patch_value)))) = received {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        match &patch.0[0] {
            json_patch::PatchOperation::Remove(remove_op) => {
                assert_eq!(remove_op.path, format!("/task_runs/{}", run.id));
            }
            _ => panic!("expected Remove operation"),
        }
    } else {
        panic!("expected to receive remove patch");
    }
}

#[tokio::test]
async fn stream_task_drafts_passes_remove_operations() {
    let (event_service, db, _temp_dir) = setup_event_service().await;

    let project = create_project(&db, "drafts-remove-project").await;
    let task = create_task(&db, project.id, "Task with Drafts").await;

    let draft = TaskDraft::new_initial(task.id, Some("Draft content".to_string()));
    insert_draft(&db, &draft).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service
        .stream_task_drafts_raw(project.id)
        .await
        .unwrap();

    let _ = stream.next().await;

    let remove_patch = json_patch::Patch(vec![json_patch::PatchOperation::Remove(
        json_patch::RemoveOperation {
            path: format!("/task_drafts/{}", draft.id),
        },
    )]);
    event_service.msg_store().push_patch(remove_patch);

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), stream.next()).await;

    if let Ok(Some(Ok(LogEntry::JsonPatch(patch_value)))) = received {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        match &patch.0[0] {
            json_patch::PatchOperation::Remove(remove_op) => {
                assert_eq!(remove_op.path, format!("/task_drafts/{}", draft.id));
            }
            _ => panic!("expected Remove operation"),
        }
    } else {
        panic!("expected to receive remove patch");
    }
}

/// Create an EventService with SQLite hook wired up for live updates
///
/// Note: The hook needs a separate DBService for reading because the update hook
/// is called during the write transaction. With WAL mode and read_uncommitted,
/// the hook should be able to see uncommitted changes.
async fn setup_event_service_with_hook() -> (EventService, DBService, tempfile::TempDir) {
    use events::EventResources;

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

/// Test that msg_store directly receives pushes (bypassing hook to verify broadcast works)
#[tokio::test]
async fn msg_store_broadcast_works() {
    use events::EventResources;

    let resources = EventResources::new();
    let msg_store = resources.msg_store();

    let mut receiver = tokio_stream::wrappers::BroadcastStream::new(msg_store.subscribe());

    let test_patch = json_patch::Patch(vec![json_patch::PatchOperation::Add(
        json_patch::AddOperation {
            path: "/test".to_string(),
            value: serde_json::json!({"hello": "world"}),
        },
    )]);
    msg_store.push_patch(test_patch);

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(100), receiver.next()).await;

    assert!(received.is_ok(), "Should receive broadcast message");
    assert!(received.unwrap().is_some(), "Should have a message");
}

/// Test that SQLite update hook fires through EventService::create_hook using process_update_hook
#[tokio::test]
async fn event_service_hook_pushes_to_msg_store() {
    use events::EventResources;

    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .with_test_writer()
        .try_init();

    let temp_dir = tempfile::tempdir().unwrap();
    let db_path = temp_dir.path().join("test.db");

    let event_resources = EventResources::new();
    let msg_store = event_resources.msg_store();

    let hook_service = DBService::new_with_path(&db_path).await.unwrap();

    let hook = EventService::create_hook(&event_resources, hook_service.clone());

    let db = DBService::new_with_path_and_hook(&db_path, hook)
        .await
        .unwrap();

    let event_service = EventService::new(db.clone(), event_resources);
    event_service.hydrate().await.unwrap();

    let mut receiver = tokio_stream::wrappers::BroadcastStream::new(msg_store.subscribe());

    let project = ProjectRecord::new("hook-test-project", "/tmp/test");
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

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let task = TaskRecord::new(project.id, "Test Task", None);
    task.insert(db.pool()).await.unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    let found = sqlx::query_as::<_, (Uuid,)>("SELECT id FROM task_records WHERE id = ?")
        .bind(task.id)
        .fetch_optional(hook_service.pool())
        .await
        .unwrap();
    assert!(
        found.is_some(),
        "Task should be visible in hook_service pool"
    );

    let mut task_entry_found = false;
    loop {
        match tokio::time::timeout(tokio::time::Duration::from_millis(50), receiver.next()).await {
            Ok(Some(Ok(entry))) => {
                if format!("{:?}", entry).contains("/tasks/") {
                    task_entry_found = true;
                }
            }
            _ => break,
        }
    }

    assert!(
        task_entry_found,
        "Hook should have pushed task entry to msg_store"
    );
}

#[tokio::test]
async fn stream_tasks_receives_live_insert_via_hook() {
    let (event_service, db, _temp_dir) = setup_event_service_with_hook().await;

    let project = create_project(&db, "live-insert-project").await;

    event_service.hydrate().await.unwrap();

    let receiver = event_service.msg_store().subscribe();

    let task = TaskRecord::new(project.id, "Live Task", None);
    task.insert(db.pool()).await.unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    let mut broadcast_receiver = tokio_stream::wrappers::BroadcastStream::new(receiver);
    let raw_received = tokio::time::timeout(
        tokio::time::Duration::from_millis(100),
        broadcast_receiver.next(),
    )
    .await;
    assert!(
        raw_received.is_ok(),
        "Should receive something on msg_store"
    );

    let mut stream = event_service.stream_tasks_raw(project.id).await.unwrap();

    let _ = stream.next().await;

    let task2 = TaskRecord::new(project.id, "Live Task 2", None);
    task2.insert(db.pool()).await.unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), stream.next()).await;

    if let Ok(Some(Ok(LogEntry::JsonPatch(patch_value)))) = received {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();
        assert_eq!(patch.0.len(), 1);

        match &patch.0[0] {
            json_patch::PatchOperation::Add(add_op) => {
                assert_eq!(add_op.path, format!("/tasks/{}", task2.id));
            }
            _ => panic!("expected Add operation, got {:?}", patch.0[0]),
        }
    } else {
        panic!(
            "expected to receive add patch for live insert, got {:?}",
            received
        );
    }
}

#[tokio::test]
async fn stream_tasks_receives_live_update_via_hook() {
    let (event_service, db, _temp_dir) = setup_event_service_with_hook().await;

    let project = create_project(&db, "live-update-project").await;
    let task = create_task(&db, project.id, "Task to Update").await;

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_tasks_raw(project.id).await.unwrap();

    let _ = stream.next().await;

    sqlx::query("UPDATE task_records SET title = ? WHERE id = ?")
        .bind("Updated Title")
        .bind(task.id)
        .execute(db.pool())
        .await
        .unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), stream.next()).await;

    if let Ok(Some(Ok(LogEntry::JsonPatch(patch_value)))) = received {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();

        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                assert_eq!(replace_op.path, format!("/tasks/{}", task.id));
            }
            _ => panic!("expected Replace operation, got: {:?}", patch.0[0]),
        }
    } else {
        panic!(
            "expected to receive replace patch for live update, got: {:?}",
            received
        );
    }
}

#[tokio::test]
async fn stream_task_runs_receives_live_status_update_via_hook() {
    let (event_service, db, _temp_dir) = setup_event_service_with_hook().await;

    let project = create_project(&db, "run-status-project").await;
    let task = create_task(&db, project.id, "Task with Run").await;
    let run = TaskRun::new_local(task.id, Some("test run".to_string()));
    run.insert(db.pool()).await.unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service.stream_task_runs_raw(task.id).await.unwrap();

    let _ = stream.next().await;

    sqlx::query("UPDATE task_runs SET status = ? WHERE id = ?")
        .bind("completed")
        .bind(run.id)
        .execute(db.pool())
        .await
        .unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), stream.next()).await;

    if let Ok(Some(Ok(LogEntry::JsonPatch(patch_value)))) = received {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();

        match &patch.0[0] {
            json_patch::PatchOperation::Replace(replace_op) => {
                assert_eq!(replace_op.path, format!("/task_runs/{}", run.id));
            }
            _ => panic!("expected Replace operation"),
        }
    } else {
        panic!("expected to receive replace patch for run status update");
    }
}

#[tokio::test]
async fn stream_task_sessions_receives_live_insert_via_hook() {
    let (event_service, db, _temp_dir) = setup_event_service_with_hook().await;

    let project = create_project(&db, "session-live-project").await;
    let task = create_task(&db, project.id, "Task with Session Updates").await;
    let run = TaskRun::new_local(task.id, Some("session run".to_string()));
    run.insert(db.pool()).await.unwrap();

    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    event_service.hydrate().await.unwrap();

    let mut stream = event_service
        .stream_task_sessions_raw(task.id)
        .await
        .unwrap();

    let _ = stream.next().await;

    let agent_id = AgentProfile::ensure_default_desktop_profile(db.pool())
        .await
        .unwrap();
    let mut session =
        TaskSession::new(task.id, agent_id, Some("Live follow-up prompt".to_string()));
    session.task_run_id = Some(run.id);
    insert_session(&db, &session).await;

    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;

    let received =
        tokio::time::timeout(tokio::time::Duration::from_millis(500), stream.next()).await;

    if let Ok(Some(Ok(LogEntry::JsonPatch(patch_value)))) = received {
        let patch: Patch = serde_json::from_value(patch_value).unwrap();

        match &patch.0[0] {
            json_patch::PatchOperation::Add(add_op) => {
                assert_eq!(add_op.path, format!("/task_sessions/{}", session.id));
            }
            _ => panic!("expected Add operation, got {:?}", patch.0[0]),
        }
    } else {
        panic!("expected to receive add patch for session insert");
    }
}
