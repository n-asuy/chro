mod msg_store;

pub use msg_store::MsgStore;

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use db::{
    models::{TaskDraft, TaskRecord, TaskRun, TaskSession},
    DBService,
};
use json_patch::{AddOperation, Patch, PatchOperation, RemoveOperation, ReplaceOperation};
pub use log_types::LogEntryPusher;
use log_types::{LogEntry, UiEventKind, UiEventPayload};
use parking_lot::RwLock;
use serde::Serialize;
use serde_json::Value;
use sqlx::sqlite::SqliteOperation;
use sqlx::{Decode, Error as SqlxError, Pool, Row, Sqlite};
use thiserror::Error;
use tokio::{runtime::Handle, sync::RwLock as AsyncRwLock};
use tracing::error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum EventError {
    #[error(transparent)]
    Sqlx(#[from] SqlxError),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct EventResources {
    msg_store: Arc<MsgStore>,
    entry_counter: Arc<AsyncRwLock<usize>>,
    indexes: EventIndexes,
}

impl EventResources {
    pub fn new() -> Self {
        Self {
            msg_store: Arc::new(MsgStore::new()),
            entry_counter: Arc::new(AsyncRwLock::new(0)),
            indexes: EventIndexes::new(),
        }
    }

    pub fn msg_store(&self) -> Arc<MsgStore> {
        self.msg_store.clone()
    }

    pub fn entry_counter(&self) -> Arc<AsyncRwLock<usize>> {
        self.entry_counter.clone()
    }

    pub(crate) fn indexes(&self) -> EventIndexes {
        self.indexes.clone()
    }
}

impl Default for EventResources {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
struct EventIndexes {
    task_projects: Arc<RwLock<HashMap<Uuid, Uuid>>>,
    task_rowids: Arc<RwLock<HashMap<i64, Uuid>>>,
    run_projects: Arc<RwLock<HashMap<Uuid, Uuid>>>,
    run_tasks: Arc<RwLock<HashMap<Uuid, Uuid>>>,
    run_rowids: Arc<RwLock<HashMap<i64, Uuid>>>,
    session_tasks: Arc<RwLock<HashMap<Uuid, Uuid>>>,
    session_rowids: Arc<RwLock<HashMap<i64, Uuid>>>,
    draft_projects: Arc<RwLock<HashMap<Uuid, Uuid>>>,
    draft_rowids: Arc<RwLock<HashMap<i64, Uuid>>>,
}

impl EventIndexes {
    fn new() -> Self {
        Self {
            task_projects: Arc::new(RwLock::new(HashMap::new())),
            task_rowids: Arc::new(RwLock::new(HashMap::new())),
            run_projects: Arc::new(RwLock::new(HashMap::new())),
            run_tasks: Arc::new(RwLock::new(HashMap::new())),
            run_rowids: Arc::new(RwLock::new(HashMap::new())),
            session_tasks: Arc::new(RwLock::new(HashMap::new())),
            session_rowids: Arc::new(RwLock::new(HashMap::new())),
            draft_projects: Arc::new(RwLock::new(HashMap::new())),
            draft_rowids: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn record_task(&self, id: Uuid, project: Uuid) {
        self.task_projects.write().insert(id, project);
    }

    fn track_task_rowid(&self, rowid: i64, id: Uuid) {
        self.task_rowids.write().insert(rowid, id);
    }

    fn project_for_task(&self, id: &Uuid) -> Option<Uuid> {
        self.task_projects.read().get(id).copied()
    }

    fn record_run(&self, id: Uuid, task: Uuid, project: Uuid) {
        self.run_projects.write().insert(id, project);
        self.run_tasks.write().insert(id, task);
    }

    fn track_run_rowid(&self, rowid: i64, id: Uuid) {
        self.run_rowids.write().insert(rowid, id);
    }

    fn task_for_run(&self, id: &Uuid) -> Option<Uuid> {
        self.run_tasks.read().get(id).copied()
    }

    fn record_session(&self, id: Uuid, task: Uuid) {
        self.session_tasks.write().insert(id, task);
    }

    fn track_session_rowid(&self, rowid: i64, id: Uuid) {
        self.session_rowids.write().insert(rowid, id);
    }

    fn task_for_session(&self, id: &Uuid) -> Option<Uuid> {
        self.session_tasks.read().get(id).copied()
    }

    fn record_draft(&self, id: Uuid, project: Uuid) {
        self.draft_projects.write().insert(id, project);
    }

    fn track_draft_rowid(&self, rowid: i64, id: Uuid) {
        self.draft_rowids.write().insert(rowid, id);
    }
}

pub struct EventService {
    db: DBService,
    resources: EventResources,
    snapshot_seeded: AtomicBool,
}

impl Clone for EventService {
    fn clone(&self) -> Self {
        Self {
            db: self.db.clone(),
            resources: self.resources.clone(),
            snapshot_seeded: AtomicBool::new(self.snapshot_seeded.load(Ordering::SeqCst)),
        }
    }
}

impl EventService {
    pub fn new(db: DBService, resources: EventResources) -> Self {
        Self {
            db,
            resources,
            snapshot_seeded: AtomicBool::new(false),
        }
    }

    pub fn msg_store(&self) -> &Arc<MsgStore> {
        &self.resources.msg_store
    }

    pub fn emit_ui_event(&self, kind: UiEventKind, data: Option<Value>) {
        self.resources
            .msg_store
            .push(LogEntry::UiEvent(UiEventPayload::new(kind, data)));
    }

    pub fn entry_counter(&self) -> &Arc<AsyncRwLock<usize>> {
        &self.resources.entry_counter
    }

    pub async fn hydrate(&self) -> Result<(), EventError> {
        if self.snapshot_seeded.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let pool = self.db.pool();

        let tasks = TaskRecord::list_all(pool).await?;
        let mut task_projects = HashMap::new();
        let mut task_map = serde_json::Map::new();
        for task in &tasks {
            task_projects.insert(task.id, task.project_id);
            task_map.insert(task.id.to_string(), serde_json::to_value(task)?);
        }
        {
            let mut guard = self.resources.indexes.task_projects.write();
            guard.clear();
            for (task_id, project_id) in &task_projects {
                guard.insert(*task_id, *project_id);
            }
        }
        {
            let mappings = fetch_row_mappings(pool, "task_records").await?;
            let mut rowids = self.resources.indexes.task_rowids.write();
            rowids.clear();
            for (rowid, id) in mappings {
                rowids.insert(rowid, id);
            }
        }

        let runs = TaskRun::list_all(pool).await?;
        let mut run_payloads = Vec::new();
        for run in runs {
            if let Some(project_id) = task_projects.get(&run.task_id).copied() {
                run_payloads.push(TaskRunEventValue::new(run, project_id));
            }
        }
        let mut run_map = serde_json::Map::new();
        let mut run_ids = HashSet::new();
        {
            let mut projects_guard = self.resources.indexes.run_projects.write();
            let mut tasks_guard = self.resources.indexes.run_tasks.write();
            projects_guard.clear();
            tasks_guard.clear();
            for payload in &run_payloads {
                projects_guard.insert(payload.run.id, payload.project_id);
                tasks_guard.insert(payload.run.id, payload.run.task_id);
                run_ids.insert(payload.run.id);
                run_map.insert(payload.run.id.to_string(), serde_json::to_value(payload)?);
            }
        }
        {
            let mappings = fetch_row_mappings(pool, "task_runs").await?;
            let mut rowids = self.resources.indexes.run_rowids.write();
            rowids.clear();
            for (rowid, id) in mappings {
                if run_ids.contains(&id) {
                    rowids.insert(rowid, id);
                }
            }
        }

        let sessions = TaskSession::list_all(pool).await?;
        let mut session_map = serde_json::Map::new();
        let mut session_ids = HashSet::new();
        {
            let mut tasks_guard = self.resources.indexes.session_tasks.write();
            tasks_guard.clear();
            for session in &sessions {
                tasks_guard.insert(session.id, session.task_id);
                session_ids.insert(session.id);
                session_map.insert(session.id.to_string(), serde_json::to_value(session)?);
            }
        }
        {
            let mappings = fetch_row_mappings(pool, "task_sessions").await?;
            let mut rowids = self.resources.indexes.session_rowids.write();
            rowids.clear();
            for (rowid, id) in mappings {
                if session_ids.contains(&id) {
                    rowids.insert(rowid, id);
                }
            }
        }

        let drafts = TaskDraft::list_all(pool).await?;
        let mut draft_payloads = Vec::new();
        for draft in drafts {
            if let Some(project_id) = task_projects.get(&draft.task_id).copied() {
                draft_payloads.push(TaskDraftEventValue::new(draft, project_id));
            }
        }
        let mut draft_map = serde_json::Map::new();
        let mut draft_ids = HashSet::new();
        {
            let mut guard = self.resources.indexes.draft_projects.write();
            guard.clear();
            for payload in &draft_payloads {
                guard.insert(payload.draft.id, payload.project_id);
                draft_ids.insert(payload.draft.id);
                draft_map.insert(payload.draft.id.to_string(), serde_json::to_value(payload)?);
            }
        }
        {
            let mappings = fetch_row_mappings(pool, "task_drafts").await?;
            let mut rowids = self.resources.indexes.draft_rowids.write();
            rowids.clear();
            for (rowid, id) in mappings {
                if draft_ids.contains(&id) {
                    rowids.insert(rowid, id);
                }
            }
        }

        let patch = Patch(vec![
            PatchOperation::Replace(ReplaceOperation {
                path: "/tasks".to_string(),
                value: Value::Object(task_map),
            }),
            PatchOperation::Replace(ReplaceOperation {
                path: "/task_runs".to_string(),
                value: Value::Object(run_map),
            }),
            PatchOperation::Replace(ReplaceOperation {
                path: "/task_sessions".to_string(),
                value: Value::Object(session_map),
            }),
            PatchOperation::Replace(ReplaceOperation {
                path: "/task_drafts".to_string(),
                value: Value::Object(draft_map),
            }),
        ]);
        self.resources.msg_store.push_patch(patch);
        Ok(())
    }

    /// Build a SQLite hook closure that pushes DB changes into the shared [`MsgStore`].
    ///
    /// Uses a dual-hook architecture matching the reference project:
    /// - **preupdate hook** (synchronous): handles DELETE operations by reading
    ///   old column values directly before the row is removed.
    /// - **update hook** (async): handles INSERT/UPDATE by querying the committed
    ///   row from a separate connection.
    ///
    /// With `JournalMode::Delete`, the update hook fires after the row is
    /// accessible to other connections, so no sleep delay is needed.
    pub fn create_hook(
        resources: &EventResources,
        db_service: DBService,
    ) -> impl for<'a> Fn(
        &'a mut sqlx::sqlite::SqliteConnection,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<(), sqlx::Error>> + Send + 'a>,
    > + Send
           + Sync
           + 'static {
        let msg_store = resources.msg_store();
        let entry_counter = resources.entry_counter();
        let indexes = resources.indexes();

        move |conn: &mut sqlx::sqlite::SqliteConnection| {
            let msg_store = msg_store.clone();
            let entry_counter = entry_counter.clone();
            let indexes = indexes.clone();
            let db_for_hook = db_service.clone();
            Box::pin(async move {
                let mut handle = conn.lock_handle().await?;
                let runtime_handle = Handle::current();

                // Preupdate hook: fires synchronously before DELETE commits.
                // Read old column values (id UUID at column 0) directly from
                // the row before it is removed.
                let msg_store_for_preupdate = msg_store.clone();
                handle.set_preupdate_hook(
                    move |preupdate: sqlx::sqlite::PreupdateHookResult<'_>| {
                        if preupdate.operation != SqliteOperation::Delete {
                            return;
                        }

                        let id = preupdate
                            .get_old_column_value(0)
                            .ok()
                            .and_then(|v| <Uuid as Decode<Sqlite>>::decode(v).ok());

                        let Some(id) = id else { return };

                        match preupdate.table {
                            "task_records" => {
                                msg_store_for_preupdate.push_patch(remove_patch("tasks", id));
                            }
                            "task_runs" => {
                                msg_store_for_preupdate.push_patch(remove_patch("task_runs", id));
                            }
                            "task_sessions" => {
                                msg_store_for_preupdate
                                    .push_patch(remove_patch("task_sessions", id));
                            }
                            "task_drafts" => {
                                msg_store_for_preupdate.push_patch(remove_patch("task_drafts", id));
                            }
                            _ => {}
                        }
                    },
                );

                // Update hook: fires for INSERT/UPDATE/DELETE.
                // DELETE is already handled by the preupdate hook above, so
                // we skip it here. INSERT/UPDATE are handled asynchronously
                // by querying the row from a separate pool connection.
                handle.set_update_hook(move |hook| {
                    if matches!(hook.operation, SqliteOperation::Delete) {
                        return;
                    }

                    let runtime_handle = runtime_handle.clone();
                    let msg_store = msg_store.clone();
                    let entry_counter = entry_counter.clone();
                    let indexes = indexes.clone();
                    let db = db_for_hook.clone();
                    let table = hook.table.to_string();
                    let operation = hook.operation.clone();
                    let rowid = hook.rowid;
                    runtime_handle.spawn(async move {
                        if let Err(err) = process_update_hook(
                            &db,
                            &msg_store,
                            &indexes,
                            &entry_counter,
                            table,
                            operation,
                            rowid,
                        )
                        .await
                        {
                            error!("event hook error: {err}");
                        }
                    });
                });

                Ok(())
            })
        }
    }
}

/// Process INSERT/UPDATE operations from the update hook.
/// DELETE is handled separately by the preupdate hook.
async fn process_update_hook(
    db: &DBService,
    msg_store: &Arc<MsgStore>,
    indexes: &EventIndexes,
    counter: &Arc<AsyncRwLock<usize>>,
    table: String,
    operation: SqliteOperation,
    rowid: i64,
) -> Result<(), sqlx::Error> {
    match table.as_str() {
        "task_records" => handle_task_upsert(db, msg_store, indexes, operation, rowid).await?,
        "task_runs" => handle_run_upsert(db, msg_store, indexes, operation, rowid).await?,
        "task_sessions" => handle_session_upsert(db, msg_store, indexes, operation, rowid).await?,
        "task_drafts" => handle_draft_upsert(db, msg_store, indexes, operation, rowid).await?,
        _ => {
            let mut guard = counter.write().await;
            *guard += 1;
            let path = format!("/entries/{}", *guard);
            let payload = serde_json::json!({
                "table": table,
                "operation": format_sqlite_op(operation),
                "rowid": rowid,
            });
            msg_store.push_patch(Patch(vec![PatchOperation::Add(AddOperation {
                path,
                value: payload,
            })]));
        }
    }
    Ok(())
}

async fn handle_task_upsert(
    db: &DBService,
    msg_store: &Arc<MsgStore>,
    indexes: &EventIndexes,
    operation: SqliteOperation,
    rowid: i64,
) -> Result<(), sqlx::Error> {
    match TaskRecord::find_by_rowid(db.pool(), rowid).await? {
        Some(task) => {
            indexes.record_task(task.id, task.project_id);
            indexes.track_task_rowid(rowid, task.id);
            match operation {
                SqliteOperation::Insert => msg_store.push_patch(add_patch("tasks", task.id, &task)),
                _ => msg_store.push_patch(replace_patch("tasks", task.id, &task)),
            }
        }
        None => {
            error!(
                table = "task_records",
                rowid,
                op = format_sqlite_op(operation),
                "find_by_rowid returned None for upsert"
            );
        }
    }
    Ok(())
}

async fn handle_run_upsert(
    db: &DBService,
    msg_store: &Arc<MsgStore>,
    indexes: &EventIndexes,
    operation: SqliteOperation,
    rowid: i64,
) -> Result<(), sqlx::Error> {
    match TaskRun::find_by_rowid(db.pool(), rowid).await? {
        Some(run) => {
            if let Some(project_id) = resolve_project_id(indexes, db, run.task_id).await? {
                indexes.record_run(run.id, run.task_id, project_id);
                indexes.track_run_rowid(rowid, run.id);
                let payload = TaskRunEventValue::new(run, project_id);
                match operation {
                    SqliteOperation::Insert => {
                        msg_store.push_patch(add_patch("task_runs", payload.run.id, &payload))
                    }
                    _ => msg_store.push_patch(replace_patch("task_runs", payload.run.id, &payload)),
                }
            }
        }
        None => {
            error!(
                table = "task_runs",
                rowid,
                op = format_sqlite_op(operation),
                "find_by_rowid returned None for upsert"
            );
        }
    }
    Ok(())
}

async fn handle_session_upsert(
    db: &DBService,
    msg_store: &Arc<MsgStore>,
    indexes: &EventIndexes,
    operation: SqliteOperation,
    rowid: i64,
) -> Result<(), sqlx::Error> {
    match TaskSession::find_by_rowid(db.pool(), rowid).await? {
        Some(session) => {
            indexes.record_session(session.id, session.task_id);
            indexes.track_session_rowid(rowid, session.id);
            match operation {
                SqliteOperation::Insert => {
                    msg_store.push_patch(add_patch("task_sessions", session.id, &session))
                }
                _ => msg_store.push_patch(replace_patch("task_sessions", session.id, &session)),
            }
        }
        None => {
            error!(
                table = "task_sessions",
                rowid,
                op = format_sqlite_op(operation),
                "find_by_rowid returned None for upsert"
            );
        }
    }
    Ok(())
}

async fn handle_draft_upsert(
    db: &DBService,
    msg_store: &Arc<MsgStore>,
    indexes: &EventIndexes,
    operation: SqliteOperation,
    rowid: i64,
) -> Result<(), sqlx::Error> {
    match TaskDraft::find_by_rowid(db.pool(), rowid).await? {
        Some(draft) => {
            if let Some(project_id) = resolve_project_id(indexes, db, draft.task_id).await? {
                indexes.record_draft(draft.id, project_id);
                indexes.track_draft_rowid(rowid, draft.id);
                let payload = TaskDraftEventValue::new(draft, project_id);
                match operation {
                    SqliteOperation::Insert => {
                        msg_store.push_patch(add_patch("task_drafts", payload.draft.id, &payload))
                    }
                    _ => msg_store.push_patch(replace_patch(
                        "task_drafts",
                        payload.draft.id,
                        &payload,
                    )),
                }
            }
        }
        None => {
            error!(
                table = "task_drafts",
                rowid,
                op = format_sqlite_op(operation),
                "find_by_rowid returned None for upsert"
            );
        }
    }
    Ok(())
}

async fn resolve_project_id(
    indexes: &EventIndexes,
    db: &DBService,
    task_id: Uuid,
) -> Result<Option<Uuid>, sqlx::Error> {
    if let Some(project) = indexes.project_for_task(&task_id) {
        return Ok(Some(project));
    }
    let project = TaskRecord::find_by_id(db.pool(), task_id)
        .await?
        .map(|task| task.project_id);
    if let Some(project_id) = project {
        indexes.record_task(task_id, project_id);
    }
    Ok(project)
}

fn format_sqlite_op(op: SqliteOperation) -> &'static str {
    match op {
        SqliteOperation::Insert => "insert",
        SqliteOperation::Update => "update",
        SqliteOperation::Delete => "delete",
        SqliteOperation::Unknown(_) => "unknown",
    }
}

fn add_patch<T: Serialize>(category: &str, id: Uuid, value: &T) -> Patch {
    Patch(vec![PatchOperation::Add(AddOperation {
        path: format!("/{}/{}", category, escape_segment(&id.to_string())),
        value: serde_json::to_value(value).unwrap_or(Value::Null),
    })])
}

fn replace_patch<T: Serialize>(category: &str, id: Uuid, value: &T) -> Patch {
    Patch(vec![PatchOperation::Replace(ReplaceOperation {
        path: format!("/{}/{}", category, escape_segment(&id.to_string())),
        value: serde_json::to_value(value).unwrap_or(Value::Null),
    })])
}

fn remove_patch(category: &str, id: Uuid) -> Patch {
    Patch(vec![PatchOperation::Remove(RemoveOperation {
        path: format!("/{}/{}", category, escape_segment(&id.to_string())),
    })])
}

fn escape_segment(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

async fn fetch_row_mappings(
    pool: &Pool<Sqlite>,
    table: &str,
) -> Result<Vec<(i64, Uuid)>, SqlxError> {
    let query = format!("SELECT rowid, id FROM {table}");
    let rows = sqlx::query(&query).fetch_all(pool).await?;
    let mut mappings = Vec::with_capacity(rows.len());
    for row in rows {
        let rowid: i64 = row.try_get("rowid")?;
        let id: Uuid = row.try_get("id")?;
        mappings.push((rowid, id));
    }
    Ok(mappings)
}

#[derive(Debug, Serialize)]
struct TaskRunEventValue {
    #[serde(flatten)]
    pub run: TaskRun,
    project_id: Uuid,
}

impl TaskRunEventValue {
    fn new(run: TaskRun, project_id: Uuid) -> Self {
        Self { run, project_id }
    }
}

#[derive(Debug, Serialize)]
struct TaskDraftEventValue {
    #[serde(flatten)]
    pub draft: TaskDraft,
    project_id: Uuid,
}

impl TaskDraftEventValue {
    fn new(draft: TaskDraft, project_id: Uuid) -> Self {
        Self { draft, project_id }
    }
}

/// Parse a hub entry as a single-op JSON Patch targeting `/{collection}/{id}`
/// and return the parsed op + id. Multi-op patches and non-matching paths
/// return `None`.
fn parse_collection_patch(entry: &LogEntry, collection: &str) -> Option<(PatchOperation, Uuid)> {
    let LogEntry::JsonPatch(patch_value) = entry else {
        return None;
    };
    let patch = serde_json::from_value::<Patch>(patch_value.clone()).ok()?;
    let op = patch.0.first()?;
    let rest = get_patch_path(op)
        .strip_prefix("/")?
        .strip_prefix(collection)?
        .strip_prefix("/")?;
    let uuid_str = rest.split('/').next().unwrap_or("");
    let id = Uuid::parse_str(uuid_str).ok()?;
    Some((op.clone(), id))
}

/// Live tail of the shared event hub for one snapshot+patch stream.
///
/// Two correctness guarantees the naive `BroadcastStream + filter_map` chain
/// did not provide:
/// - The receiver must be created *before* the caller reads its snapshot
///   (callers do this; the receiver is passed in), so no event can fall into
///   the gap between the snapshot read and the subscription.
/// - When this receiver falls behind the broadcast buffer (`Lagged`), the
///   missed events are unrecoverable — silently continuing desyncs every
///   client on this socket until reconnect. Instead, drop the stale backlog
///   (`resubscribe` points at the tail) and emit a fresh full snapshot, which
///   supersedes whatever was lost.
fn live_stream_with_resync<F, S, Fut>(
    rx: tokio::sync::broadcast::Receiver<LogEntry>,
    filter: F,
    resnapshot: S,
) -> futures::stream::BoxStream<'static, Result<LogEntry, std::io::Error>>
where
    F: Fn(&LogEntry) -> bool + Send + 'static,
    S: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<LogEntry, EventError>> + Send,
{
    use futures::StreamExt;
    use tokio::sync::broadcast::error::RecvError;

    futures::stream::unfold(
        (rx, filter, resnapshot),
        |(mut rx, filter, resnapshot)| async move {
            loop {
                match rx.recv().await {
                    Ok(entry) => {
                        if filter(&entry) {
                            return Some((Ok(entry), (rx, filter, resnapshot)));
                        }
                    }
                    Err(RecvError::Lagged(missed)) => {
                        tracing::warn!(missed, "event stream lagged; resyncing from snapshot");
                        rx = rx.resubscribe();
                        let snapshot = resnapshot().await.map_err(std::io::Error::other);
                        return Some((snapshot, (rx, filter, resnapshot)));
                    }
                    Err(RecvError::Closed) => return None,
                }
            }
        },
    )
    .boxed()
}

impl EventService {
    /// Stream tasks for a specific project with initial snapshot + live updates
    pub async fn stream_tasks_raw(
        &self,
        project_id: Uuid,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogEntry, std::io::Error>>, EventError>
    {
        use futures::StreamExt;

        let pool = self.db.pool().clone();
        let make_snapshot = move || {
            let pool = pool.clone();
            async move {
                let tasks = TaskRecord::list_by_project(&pool, project_id).await?;
                let mut tasks_map = serde_json::Map::new();
                for task in &tasks {
                    tasks_map.insert(task.id.to_string(), serde_json::to_value(task)?);
                }
                Ok(LogEntry::from(Patch(vec![PatchOperation::Replace(
                    ReplaceOperation {
                        path: "/tasks".to_string(),
                        value: Value::Object(tasks_map),
                    },
                )])))
            }
        };

        // Subscribe before the snapshot read so nothing falls in between.
        let rx = self.resources.msg_store.subscribe();
        let initial_msg = make_snapshot().await?;

        let indexes = self.resources.indexes.clone();
        let filter = move |entry: &LogEntry| -> bool {
            match parse_collection_patch(entry, "tasks") {
                Some((op, task_id)) => {
                    matches!(op, PatchOperation::Remove(_))
                        || indexes.project_for_task(&task_id) == Some(project_id)
                }
                None => !matches!(entry, LogEntry::JsonPatch(_)),
            }
        };

        let initial_stream = futures::stream::once(async move { Ok(initial_msg) });
        Ok(initial_stream
            .chain(live_stream_with_resync(rx, filter, make_snapshot))
            .boxed())
    }

    /// Stream tasks across all projects with initial snapshot + live updates.
    ///
    /// Unlike [`EventService::stream_tasks_raw`], no project filter is applied:
    /// every task patch (add/replace/remove) is forwarded. Each task value
    /// already carries its `project_id`, so the cross-project inbox can render
    /// and route without a per-project subscription.
    pub async fn stream_all_tasks_raw(
        &self,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogEntry, std::io::Error>>, EventError>
    {
        use futures::StreamExt;

        let pool = self.db.pool().clone();
        let make_snapshot = move || {
            let pool = pool.clone();
            async move {
                let tasks = TaskRecord::list_all(&pool).await?;
                let mut tasks_map = serde_json::Map::new();
                for task in &tasks {
                    tasks_map.insert(task.id.to_string(), serde_json::to_value(task)?);
                }
                Ok(LogEntry::from(Patch(vec![PatchOperation::Replace(
                    ReplaceOperation {
                        path: "/tasks".to_string(),
                        value: Value::Object(tasks_map),
                    },
                )])))
            }
        };

        // Subscribe before the snapshot read so nothing falls in between.
        let rx = self.resources.msg_store.subscribe();
        let initial_msg = make_snapshot().await?;

        let filter = |entry: &LogEntry| -> bool {
            match entry {
                LogEntry::JsonPatch(_) => parse_collection_patch(entry, "tasks").is_some(),
                _ => true,
            }
        };

        let initial_stream = futures::stream::once(async move { Ok(initial_msg) });
        Ok(initial_stream
            .chain(live_stream_with_resync(rx, filter, make_snapshot))
            .boxed())
    }

    /// Stream task runs for a specific task with initial snapshot + live updates
    pub async fn stream_task_runs_raw(
        &self,
        task_id: Uuid,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogEntry, std::io::Error>>, EventError>
    {
        use futures::StreamExt;

        let pool = self.db.pool().clone();
        let make_snapshot = move || {
            let pool = pool.clone();
            async move {
                let runs = TaskRun::list_by_task_id(&pool, task_id).await?;
                let project_id = TaskRecord::find_by_id(&pool, task_id)
                    .await?
                    .map(|t| t.project_id);

                let mut runs_map = serde_json::Map::new();
                for run in &runs {
                    if let Some(project_id) = project_id {
                        let payload = TaskRunEventValue::new(run.clone(), project_id);
                        runs_map.insert(run.id.to_string(), serde_json::to_value(&payload)?);
                    }
                }
                Ok(LogEntry::from(Patch(vec![PatchOperation::Replace(
                    ReplaceOperation {
                        path: "/task_runs".to_string(),
                        value: Value::Object(runs_map),
                    },
                )])))
            }
        };

        // Subscribe before the snapshot read so nothing falls in between.
        let rx = self.resources.msg_store.subscribe();
        let initial_msg = make_snapshot().await?;

        let indexes = self.resources.indexes.clone();
        let filter = move |entry: &LogEntry| -> bool {
            match parse_collection_patch(entry, "task_runs") {
                Some((op, run_id)) => {
                    let run_task = indexes.task_for_run(&run_id);
                    if matches!(op, PatchOperation::Remove(_)) {
                        run_task.is_none() || run_task == Some(task_id)
                    } else {
                        run_task == Some(task_id)
                    }
                }
                None => !matches!(entry, LogEntry::JsonPatch(_)),
            }
        };

        let initial_stream = futures::stream::once(async move { Ok(initial_msg) });
        Ok(initial_stream
            .chain(live_stream_with_resync(rx, filter, make_snapshot))
            .boxed())
    }

    /// Stream task sessions for a specific task with initial snapshot + live updates
    pub async fn stream_task_sessions_raw(
        &self,
        task_id: Uuid,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogEntry, std::io::Error>>, EventError>
    {
        use futures::StreamExt;

        let pool = self.db.pool().clone();
        let make_snapshot = move || {
            let pool = pool.clone();
            async move {
                let sessions = TaskSession::list_by_task_id(&pool, task_id).await?;
                let mut sessions_map = serde_json::Map::new();
                for session in &sessions {
                    sessions_map.insert(session.id.to_string(), serde_json::to_value(session)?);
                }
                Ok(LogEntry::from(Patch(vec![PatchOperation::Replace(
                    ReplaceOperation {
                        path: "/task_sessions".to_string(),
                        value: Value::Object(sessions_map),
                    },
                )])))
            }
        };

        // Subscribe before the snapshot read so nothing falls in between.
        let rx = self.resources.msg_store.subscribe();
        let initial_msg = make_snapshot().await?;

        let indexes = self.resources.indexes.clone();
        let filter = move |entry: &LogEntry| -> bool {
            match parse_collection_patch(entry, "task_sessions") {
                Some((op, session_id)) => {
                    let session_task = indexes.task_for_session(&session_id);
                    if matches!(op, PatchOperation::Remove(_)) {
                        session_task.is_none() || session_task == Some(task_id)
                    } else {
                        session_task == Some(task_id)
                    }
                }
                None => !matches!(entry, LogEntry::JsonPatch(_)),
            }
        };

        let initial_stream = futures::stream::once(async move { Ok(initial_msg) });
        Ok(initial_stream
            .chain(live_stream_with_resync(rx, filter, make_snapshot))
            .boxed())
    }

    /// Stream task drafts for a specific project with initial snapshot + live updates
    pub async fn stream_task_drafts_raw(
        &self,
        project_id: Uuid,
    ) -> Result<futures::stream::BoxStream<'static, Result<LogEntry, std::io::Error>>, EventError>
    {
        use futures::StreamExt;

        let pool = self.db.pool().clone();
        let snapshot_indexes = self.resources.indexes.clone();
        let make_snapshot = move || {
            let pool = pool.clone();
            let indexes = snapshot_indexes.clone();
            async move {
                let drafts = TaskDraft::list_all(&pool).await?;
                let mut drafts_map = serde_json::Map::new();
                for draft in &drafts {
                    if let Some(proj_id) = indexes.project_for_task(&draft.task_id) {
                        if proj_id == project_id {
                            let payload = TaskDraftEventValue::new(draft.clone(), proj_id);
                            drafts_map
                                .insert(draft.id.to_string(), serde_json::to_value(&payload)?);
                        }
                    }
                }
                Ok(LogEntry::from(Patch(vec![PatchOperation::Replace(
                    ReplaceOperation {
                        path: "/task_drafts".to_string(),
                        value: Value::Object(drafts_map),
                    },
                )])))
            }
        };

        // Subscribe before the snapshot read so nothing falls in between.
        let rx = self.resources.msg_store.subscribe();
        let initial_msg = make_snapshot().await?;

        let indexes = self.resources.indexes.clone();
        let filter = move |entry: &LogEntry| -> bool {
            match parse_collection_patch(entry, "task_drafts") {
                Some((op, draft_id)) => {
                    matches!(op, PatchOperation::Remove(_))
                        || indexes.draft_projects.read().get(&draft_id).copied() == Some(project_id)
                }
                None => !matches!(entry, LogEntry::JsonPatch(_)),
            }
        };

        let initial_stream = futures::stream::once(async move { Ok(initial_msg) });
        Ok(initial_stream
            .chain(live_stream_with_resync(rx, filter, make_snapshot))
            .boxed())
    }
}

/// Helper to extract path from PatchOperation
fn get_patch_path(op: &PatchOperation) -> &str {
    match op {
        PatchOperation::Add(o) => &o.path,
        PatchOperation::Remove(o) => &o.path,
        PatchOperation::Replace(o) => &o.path,
        PatchOperation::Move(o) => &o.path,
        PatchOperation::Copy(o) => &o.path,
        PatchOperation::Test(o) => &o.path,
    }
}
