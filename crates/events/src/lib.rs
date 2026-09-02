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
use tokio::{runtime::Handle, sync::mpsc, sync::RwLock as AsyncRwLock};
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
    /// The hooks only *record* which rows a statement touched; nothing is
    /// published from inside them:
    /// - **preupdate hook** (synchronous): a DELETE's id can only be read before
    ///   the row is gone, so it is captured here and buffered.
    /// - **update hook** (synchronous): buffers the rowid of every INSERT/UPDATE.
    /// - **commit hook**: hands the buffer to the dispatcher.
    /// - **rollback hook**: drops the buffer, so an abandoned write publishes
    ///   nothing.
    ///
    /// Publishing is deferred because the update hook fires *inside* the writing
    /// statement, before its transaction commits, while the row is read back on a
    /// different pool connection. Under WAL that reader sees the last committed
    /// snapshot, so publishing from the hook races the writer's own commit and
    /// can broadcast the pre-update row — and since no further change fires for
    /// that row, the stale value stays the last word (a finished run left
    /// `running`, pinning the composer's Stop button until a reload).
    ///
    /// The dispatcher is a single consumer, so reads also happen in commit order:
    /// concurrent per-row tasks could otherwise let an older read land after a
    /// newer one and reintroduce the same staleness.
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

        let (dispatch_tx, dispatch_rx) = mpsc::unbounded_channel::<Vec<PendingChange>>();
        let dispatch_rx = Arc::new(std::sync::Mutex::new(Some(dispatch_rx)));

        move |conn: &mut sqlx::sqlite::SqliteConnection| {
            let msg_store = msg_store.clone();
            let entry_counter = entry_counter.clone();
            let indexes = indexes.clone();
            let db_for_hook = db_service.clone();
            let dispatch_tx = dispatch_tx.clone();
            let dispatch_rx = dispatch_rx.clone();
            Box::pin(async move {
                let mut handle = conn.lock_handle().await?;

                // One dispatcher serves every pooled connection; the first one to
                // connect starts it.
                let receiver = dispatch_rx.lock().ok().and_then(|mut slot| slot.take());
                if let Some(receiver) = receiver {
                    Handle::current().spawn(dispatch_committed_changes(
                        db_for_hook,
                        msg_store,
                        indexes,
                        entry_counter,
                        receiver,
                    ));
                }

                // Buffer of rows this connection has touched since its last
                // commit or rollback.
                let pending: Arc<parking_lot::Mutex<Vec<PendingChange>>> =
                    Arc::new(parking_lot::Mutex::new(Vec::new()));

                let pending_for_preupdate = pending.clone();
                handle.set_preupdate_hook(
                    move |preupdate: sqlx::sqlite::PreupdateHookResult<'_>| {
                        if preupdate.operation != SqliteOperation::Delete {
                            return;
                        }

                        let Some(collection) = collection_for_table(preupdate.table) else {
                            return;
                        };

                        // The id (column 0) is only readable while the row still
                        // exists, so it is decoded now and published on commit.
                        let id = preupdate
                            .get_old_column_value(0)
                            .ok()
                            .and_then(|v| <Uuid as Decode<Sqlite>>::decode(v).ok());

                        let Some(id) = id else { return };

                        pending_for_preupdate
                            .lock()
                            .push(PendingChange::Delete { collection, id });
                    },
                );

                let pending_for_update = pending.clone();
                handle.set_update_hook(move |hook| {
                    // DELETE is captured by the preupdate hook above, which is the
                    // only place the row is still readable.
                    if matches!(hook.operation, SqliteOperation::Delete) {
                        return;
                    }

                    pending_for_update.lock().push(PendingChange::Upsert {
                        table: hook.table.to_string(),
                        operation: hook.operation.clone(),
                        rowid: hook.rowid,
                    });
                });

                let pending_for_commit = pending.clone();
                handle.set_commit_hook(move || {
                    let changes = std::mem::take(&mut *pending_for_commit.lock());
                    if !changes.is_empty() {
                        let _ = dispatch_tx.send(changes);
                    }
                    // Never veto the commit.
                    true
                });

                let pending_for_rollback = pending;
                handle.set_rollback_hook(move || {
                    pending_for_rollback.lock().clear();
                });

                Ok(())
            })
        }
    }
}

/// A row a statement touched, waiting for its transaction to be decided.
enum PendingChange {
    Upsert {
        table: String,
        operation: SqliteOperation,
        rowid: i64,
    },
    Delete {
        collection: &'static str,
        id: Uuid,
    },
}

/// The patch collection a table's rows are published under, or `None` for tables
/// that are not part of the streamed state.
fn collection_for_table(table: &str) -> Option<&'static str> {
    match table {
        "task_records" => Some("tasks"),
        "task_runs" => Some("task_runs"),
        "task_sessions" => Some("task_sessions"),
        "task_drafts" => Some("task_drafts"),
        _ => None,
    }
}

/// How long to keep re-reading a row that still looks unchanged before giving up
/// and publishing whatever is there. The commit being waited on is already
/// in-flight on another thread, so this is microseconds in practice; the budget
/// only bounds the pathological case (a write that genuinely changed nothing).
const READ_BACK_YIELDS: usize = 8;
const READ_BACK_SLEEPS: usize = 20;
const READ_BACK_SLEEP: std::time::Duration = std::time::Duration::from_millis(1);

/// Read back and publish committed rows, one batch at a time in commit order.
///
/// Single-consumer on purpose: a task per row would let an older read land after
/// a newer one and leave the stale value as the last word for that row.
async fn dispatch_committed_changes(
    db: DBService,
    msg_store: Arc<MsgStore>,
    indexes: EventIndexes,
    entry_counter: Arc<AsyncRwLock<usize>>,
    mut receiver: mpsc::UnboundedReceiver<Vec<PendingChange>>,
) {
    // Fingerprint of the last value published per row. A read-back that returns
    // exactly what was published last has not observed the change it is
    // reporting, which is how a pre-commit read is recognised without needing to
    // know what the new value should be.
    let mut published: HashMap<(&'static str, Uuid), u64> = HashMap::new();

    while let Some(batch) = receiver.recv().await {
        for change in batch {
            match change {
                PendingChange::Delete { collection, id } => {
                    published.remove(&(collection, id));
                    msg_store.push_patch(remove_patch(collection, id));
                }
                PendingChange::Upsert {
                    table,
                    operation,
                    rowid,
                } => {
                    if collection_for_table(&table).is_none() {
                        let mut guard = entry_counter.write().await;
                        *guard += 1;
                        let path = format!("/entries/{}", *guard);
                        msg_store.push_patch(Patch(vec![PatchOperation::Add(AddOperation {
                            path,
                            value: serde_json::json!({
                                "table": table,
                                "operation": format_sqlite_op(operation),
                                "rowid": rowid,
                            }),
                        })]));
                        continue;
                    }

                    publish_changed_row(
                        &db,
                        &msg_store,
                        &indexes,
                        &mut published,
                        &table,
                        operation,
                        rowid,
                    )
                    .await;
                }
            }
        }
    }
}

/// Publish a changed row once the read-back actually reflects the change.
async fn publish_changed_row(
    db: &DBService,
    msg_store: &Arc<MsgStore>,
    indexes: &EventIndexes,
    published: &mut HashMap<(&'static str, Uuid), u64>,
    table: &str,
    operation: SqliteOperation,
    rowid: i64,
) {
    let attempts = READ_BACK_YIELDS + READ_BACK_SLEEPS;
    for attempt in 0..=attempts {
        let snapshot = match read_changed_row(db, indexes, table, rowid).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                error!("event hook error: {err}");
                return;
            }
        };

        let last_attempt = attempt == attempts;
        if let Some(snapshot) = snapshot {
            let key = (snapshot.collection, snapshot.id);
            let fingerprint = fingerprint(&snapshot.value);
            if !last_attempt && published.get(&key) == Some(&fingerprint) {
                // Still the value already on the wire: the change is not
                // visible on this connection yet.
                back_off(attempt).await;
                continue;
            }

            published.insert(key, fingerprint);
            let path = format!(
                "/{}/{}",
                snapshot.collection,
                escape_segment(&snapshot.id.to_string())
            );
            let value = snapshot.value;
            msg_store.push_patch(Patch(vec![match operation {
                SqliteOperation::Insert => PatchOperation::Add(AddOperation { path, value }),
                _ => PatchOperation::Replace(ReplaceOperation { path, value }),
            }]));
            return;
        }

        // An insert whose row is not there yet is the same race seen from the
        // other side; dropping it silently is what left rows missing from the UI.
        if last_attempt {
            error!(
                table,
                rowid,
                op = format_sqlite_op(operation),
                "row was never visible after its commit; change not published"
            );
            return;
        }
        back_off(attempt).await;
    }
}

async fn back_off(attempt: usize) {
    if attempt < READ_BACK_YIELDS {
        tokio::task::yield_now().await;
    } else {
        tokio::time::sleep(READ_BACK_SLEEP).await;
    }
}

/// A committed row, ready to publish.
struct RowSnapshot {
    collection: &'static str,
    id: Uuid,
    value: Value,
}

/// Read back the row a change refers to, refreshing the routing indexes.
///
/// `Ok(None)` means the row is not visible on this connection: either it was
/// deleted again, or — the case this whole path guards against — the writer's
/// transaction has not landed yet.
async fn read_changed_row(
    db: &DBService,
    indexes: &EventIndexes,
    table: &str,
    rowid: i64,
) -> Result<Option<RowSnapshot>, sqlx::Error> {
    let snapshot = match table {
        "task_records" => TaskRecord::find_by_rowid(db.pool(), rowid)
            .await?
            .map(|task| {
                indexes.record_task(task.id, task.project_id);
                indexes.track_task_rowid(rowid, task.id);
                RowSnapshot {
                    collection: "tasks",
                    id: task.id,
                    value: serde_json::to_value(&task).unwrap_or(Value::Null),
                }
            }),
        "task_runs" => match TaskRun::find_by_rowid(db.pool(), rowid).await? {
            Some(run) => match resolve_project_id(indexes, db, run.task_id).await? {
                Some(project_id) => {
                    indexes.record_run(run.id, run.task_id, project_id);
                    indexes.track_run_rowid(rowid, run.id);
                    let payload = TaskRunEventValue::new(run, project_id);
                    Some(RowSnapshot {
                        collection: "task_runs",
                        id: payload.run.id,
                        value: serde_json::to_value(&payload).unwrap_or(Value::Null),
                    })
                }
                None => None,
            },
            None => None,
        },
        "task_sessions" => TaskSession::find_by_rowid(db.pool(), rowid)
            .await?
            .map(|session| {
                indexes.record_session(session.id, session.task_id);
                indexes.track_session_rowid(rowid, session.id);
                RowSnapshot {
                    collection: "task_sessions",
                    id: session.id,
                    value: serde_json::to_value(&session).unwrap_or(Value::Null),
                }
            }),
        "task_drafts" => match TaskDraft::find_by_rowid(db.pool(), rowid).await? {
            Some(draft) => match resolve_project_id(indexes, db, draft.task_id).await? {
                Some(project_id) => {
                    indexes.record_draft(draft.id, project_id);
                    indexes.track_draft_rowid(rowid, draft.id);
                    let payload = TaskDraftEventValue::new(draft, project_id);
                    Some(RowSnapshot {
                        collection: "task_drafts",
                        id: payload.draft.id,
                        value: serde_json::to_value(&payload).unwrap_or(Value::Null),
                    })
                }
                None => None,
            },
            None => None,
        },
        _ => None,
    };
    Ok(snapshot)
}

fn fingerprint(value: &Value) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.to_string().hash(&mut hasher);
    hasher.finish()
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
