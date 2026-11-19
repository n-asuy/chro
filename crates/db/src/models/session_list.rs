//! The session list as a paired phone reads it.
//!
//! The desktop inbox streams every task record (descriptions included) of
//! every project. A phone shows a few rows per project, never shows archived
//! sessions in its list, and reads only a handful of fields, so it gets its
//! own projection ([`SessionListItem`]), its own selection ([`SessionWindow`])
//! and paged lookups ([`SessionQuery`]) for everything outside the window.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{FromRow, Pool, QueryBuilder, Sqlite};
use uuid::Uuid;

use crate::{models::TaskRecord, types::TaskStatus};

/// The status the desktop treats as archived (use-archived-sessions.ts).
pub const ARCHIVED_STATUS: TaskStatus = TaskStatus::Cancelled;

/// One session with exactly the fields the phone's list, pins, palette, Home
/// recent, grouping and session header read. Keys and types match
/// [`TaskRecord`]'s, so a phone decodes both with one type.
#[derive(Debug, Clone, PartialEq, Serialize, FromRow)]
pub struct SessionListItem {
    pub id: Uuid,
    pub project_id: Uuid,
    pub title: String,
    pub status: TaskStatus,
    pub branch: Option<String>,
    pub worktree_deleted: bool,
    pub active_session_id: Option<Uuid>,
    pub awaiting_input: bool,
    pub updated_at: DateTime<Utc>,
    pub last_executor: Option<String>,
    pub last_summary: Option<String>,
    pub note: Option<String>,
    pub forked_from_title: Option<String>,
    pub delegated_from_id: Option<Uuid>,
}

impl From<TaskRecord> for SessionListItem {
    fn from(task: TaskRecord) -> Self {
        Self {
            id: task.id,
            project_id: task.project_id,
            title: task.title,
            status: task.status,
            branch: task.branch,
            worktree_deleted: task.worktree_deleted,
            active_session_id: task.active_session_id,
            awaiting_input: task.awaiting_input,
            updated_at: task.updated_at,
            last_executor: task.last_executor,
            last_summary: task.last_summary,
            note: task.note,
            forked_from_title: task.forked_from_title,
            delegated_from_id: task.delegated_from_id,
        }
    }
}

impl SessionListItem {
    pub fn is_archived(&self) -> bool {
        self.status == ARCHIVED_STATUS
    }

    fn is_running(&self) -> bool {
        self.active_session_id.is_some()
    }
}

/// Selects the item columns with the fork and delegate edges, as
/// `SELECT_TASKS_WITH_FORK` does for full records.
const SELECT_ITEMS: &str = "SELECT t.id, t.project_id, t.title, t.status, t.branch, \
     t.worktree_deleted, t.active_session_id, t.awaiting_input, t.updated_at, \
     t.last_executor, t.last_summary, t.note, \
     f.label AS forked_from_title, d.target_task_id AS delegated_from_id \
     FROM task_records t \
     LEFT JOIN task_context_refs f ON f.task_id = t.id AND f.kind = 'fork' \
     LEFT JOIN task_context_refs d ON d.task_id = t.id AND d.kind = 'delegate'";

/// How the list orders sessions inside a project (projects-panel.tsx SortMode).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SessionSort {
    #[default]
    Recent,
    NameAscending,
    NameDescending,
}

impl SessionSort {
    /// The desktop's stored names (`workspace-layout:projects-sort-mode:v1`).
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "recent" => Some(Self::Recent),
            "name-asc" => Some(Self::NameAscending),
            "name-desc" => Some(Self::NameDescending),
            _ => None,
        }
    }

    /// `ORDER BY` terms matching [`Self::compare`].
    fn order_by(self) -> &'static str {
        match self {
            Self::Recent => "t.updated_at DESC, t.id",
            Self::NameAscending => "lower(t.title), t.id",
            Self::NameDescending => "lower(t.title) DESC, t.id",
        }
    }

    /// The order of [`Self::order_by`]: SQLite's `lower` folds ASCII only, so
    /// this does too, and ids break ties the same way.
    fn compare(self, a: &SessionListItem, b: &SessionListItem) -> std::cmp::Ordering {
        let name = |item: &SessionListItem| item.title.to_ascii_lowercase();
        let primary = match self {
            Self::Recent => b.updated_at.cmp(&a.updated_at),
            Self::NameAscending => name(a).cmp(&name(b)),
            Self::NameDescending => name(b).cmp(&name(a)),
        };
        primary.then_with(|| a.id.as_bytes().cmp(b.id.as_bytes()))
    }
}

/// Which live (non-archived) sessions a phone holds.
///
/// A phone renders, per project, the first rows of its sort order (preview
/// and "Show more"), the newest rows (Home's Recent), the newest sessions
/// across projects (the palette's Recent), sessions that need the user, and
/// the sessions it pinned or opened. Delegation trees come whole, so a
/// delegated session nests under its delegator and shows its title.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionWindow {
    pub sort: SessionSort,
    /// Rows per project, of the sort order and of recency.
    pub per_project: usize,
    /// Projects whose list was extended with "Show more".
    pub project_limits: HashMap<Uuid, usize>,
    /// Newest sessions across all projects.
    pub recent: usize,
    /// Sessions held regardless of their position (pins, opened sessions).
    pub include: HashSet<Uuid>,
}

impl SessionWindow {
    /// Rows per project: Home's Recent shows 8; the list previews 5 and keeps
    /// a margin for rows folded under delegations.
    pub const DEFAULT_PER_PROJECT: usize = 10;
    /// The palette's Recent section (palette-navigation.ts).
    pub const DEFAULT_RECENT: usize = 15;
    /// Most rows a project may be extended to.
    pub const MAX_PER_PROJECT: usize = 1_000;
    /// Most sessions a window may name explicitly.
    pub const MAX_INCLUDED: usize = 500;

    pub fn new(sort: SessionSort) -> Self {
        Self {
            sort,
            per_project: Self::DEFAULT_PER_PROJECT,
            project_limits: HashMap::new(),
            recent: Self::DEFAULT_RECENT,
            include: HashSet::new(),
        }
    }

    fn limit_for(&self, project_id: &Uuid) -> usize {
        self.project_limits
            .get(project_id)
            .copied()
            .unwrap_or(self.per_project)
            .max(self.per_project)
    }

    /// The window's sessions among `live` (non-archived) ones, newest first.
    pub fn select(&self, live: Vec<SessionListItem>) -> Vec<SessionListItem> {
        let mut by_recency = live;
        by_recency.retain(|item| !item.is_archived());
        by_recency.sort_by(|a, b| SessionSort::Recent.compare(a, b));

        let mut chosen: HashSet<Uuid> = HashSet::new();
        // Newest sessions across projects, and the newest of each project.
        let mut taken: HashMap<Uuid, usize> = HashMap::new();
        for (position, item) in by_recency.iter().enumerate() {
            let count = taken.entry(item.project_id).or_default();
            if *count < self.limit_for(&item.project_id) || position < self.recent {
                chosen.insert(item.id);
            }
            *count += 1;
        }
        // The first rows of each project in the list's own order.
        if self.sort != SessionSort::Recent {
            let mut by_name: Vec<&SessionListItem> = by_recency.iter().collect();
            by_name.sort_by(|a, b| self.sort.compare(a, b));
            let mut taken: HashMap<Uuid, usize> = HashMap::new();
            for item in by_name {
                let count = taken.entry(item.project_id).or_default();
                if *count < self.limit_for(&item.project_id) {
                    chosen.insert(item.id);
                }
                *count += 1;
            }
        }
        // Sessions that need the user, and the ones named explicitly.
        for item in &by_recency {
            if item.is_running()
                || item.awaiting_input
                || item.status == TaskStatus::Failed
                || self.include.contains(&item.id)
            {
                chosen.insert(item.id);
            }
        }
        // Whole delegation trees: up to each root, then every descendant.
        let parent_of: HashMap<Uuid, Uuid> = by_recency
            .iter()
            .filter_map(|item| item.delegated_from_id.map(|parent| (item.id, parent)))
            .collect();
        let live_ids: HashSet<Uuid> = by_recency.iter().map(|item| item.id).collect();
        let mut roots: HashSet<Uuid> = HashSet::new();
        for id in &chosen {
            let mut at = *id;
            let mut seen = HashSet::from([at]);
            while let Some(parent) = parent_of.get(&at).copied() {
                if !live_ids.contains(&parent) || !seen.insert(parent) {
                    break;
                }
                at = parent;
            }
            roots.insert(at);
        }
        let mut children: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for (child, parent) in &parent_of {
            children.entry(*parent).or_default().push(*child);
        }
        let mut walked: HashSet<Uuid> = HashSet::new();
        let mut pending: Vec<Uuid> = roots.into_iter().collect();
        while let Some(id) = pending.pop() {
            if !walked.insert(id) {
                continue;
            }
            chosen.insert(id);
            pending.extend(children.get(&id).into_iter().flatten().copied());
        }

        by_recency.retain(|item| chosen.contains(&item.id));
        by_recency
    }
}

/// Live and archived sessions of one project.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct SessionCounts {
    pub live: i64,
    pub archived: i64,
}

/// A paged lookup outside the window: "Show more", search, the archive, and
/// sessions named by id.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionQuery {
    pub project_id: Option<Uuid>,
    /// Archived sessions instead of live ones.
    pub archived: bool,
    /// Case-insensitive substring of the title or the project's name.
    pub text: Option<String>,
    /// Only these sessions (live or archived per `archived`).
    pub ids: Vec<Uuid>,
    pub sort: SessionSort,
    pub offset: usize,
    pub limit: usize,
}

impl SessionQuery {
    pub const DEFAULT_LIMIT: usize = 50;
    pub const MAX_LIMIT: usize = 200;
}

/// A page of [`SessionQuery`] results and how many match in all.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionPage {
    pub sessions: Vec<SessionListItem>,
    pub total: i64,
}

impl SessionListItem {
    /// Every live (non-archived) session.
    pub async fn list_live(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!("{SELECT_ITEMS} WHERE t.status != ?"))
            .bind(ARCHIVED_STATUS)
            .fetch_all(pool)
            .await
    }

    /// Live and archived counts of every project that has sessions.
    pub async fn counts(pool: &Pool<Sqlite>) -> Result<BTreeMap<Uuid, SessionCounts>, sqlx::Error> {
        let rows: Vec<(Uuid, i64, i64)> = sqlx::query_as(
            "SELECT project_id, SUM(status != ?), SUM(status = ?) FROM task_records GROUP BY project_id",
        )
        .bind(ARCHIVED_STATUS)
        .bind(ARCHIVED_STATUS)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(project_id, live, archived)| (project_id, SessionCounts { live, archived }))
            .collect())
    }

    /// One page of `query`, in its sort order.
    pub async fn query(
        pool: &Pool<Sqlite>,
        query: &SessionQuery,
    ) -> Result<SessionPage, sqlx::Error> {
        fn filters<'a>(builder: &mut QueryBuilder<'a, Sqlite>, query: &'a SessionQuery) {
            builder.push(if query.archived {
                " WHERE t.status = "
            } else {
                " WHERE t.status != "
            });
            builder.push_bind(ARCHIVED_STATUS);
            if let Some(project_id) = query.project_id {
                builder.push(" AND t.project_id = ").push_bind(project_id);
            }
            if !query.ids.is_empty() {
                builder.push(" AND t.id IN (");
                let mut ids = builder.separated(", ");
                for id in &query.ids {
                    ids.push_bind(*id);
                }
                builder.push(")");
            }
            if let Some(text) = query.text.as_deref().filter(|text| !text.is_empty()) {
                let pattern = format!("%{}%", escape_like(text));
                builder
                    .push(" AND (t.title LIKE ")
                    .push_bind(pattern.clone())
                    .push(" ESCAPE '\\' OR p.name LIKE ")
                    .push_bind(pattern)
                    .push(" ESCAPE '\\')");
            }
        }
        const FROM_PROJECT: &str = " LEFT JOIN project_records p ON p.id = t.project_id";
        let limit = query.limit.clamp(1, SessionQuery::MAX_LIMIT);

        let mut select = QueryBuilder::<Sqlite>::new(SELECT_ITEMS);
        select.push(FROM_PROJECT);
        filters(&mut select, query);
        select
            .push(format!(" ORDER BY {} LIMIT ", query.sort.order_by()))
            .push_bind(limit as i64)
            .push(" OFFSET ")
            .push_bind(query.offset as i64);
        let sessions = select.build_query_as::<Self>().fetch_all(pool).await?;

        let mut count = QueryBuilder::<Sqlite>::new("SELECT COUNT(*) FROM task_records t");
        count.push(FROM_PROJECT);
        filters(&mut count, query);
        let total: i64 = count.build_query_scalar().fetch_one(pool).await?;
        Ok(SessionPage { sessions, total })
    }
}

fn escape_like(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;
    use crate::models::{ProjectRecord, TaskContextRef, TaskContextRefInput};

    fn at(minute: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 16, 0, minute, 0).unwrap()
    }

    fn item(project_id: Uuid, title: &str, minute: u32) -> SessionListItem {
        SessionListItem {
            id: Uuid::new_v4(),
            project_id,
            title: title.to_string(),
            status: TaskStatus::Completed,
            branch: None,
            worktree_deleted: false,
            active_session_id: None,
            awaiting_input: false,
            updated_at: at(minute),
            last_executor: None,
            last_summary: None,
            note: None,
            forked_from_title: None,
            delegated_from_id: None,
        }
    }

    fn titles(items: &[SessionListItem]) -> Vec<&str> {
        let mut titles: Vec<&str> = items.iter().map(|item| item.title.as_str()).collect();
        titles.sort_unstable();
        titles
    }

    fn window(per_project: usize, recent: usize) -> SessionWindow {
        SessionWindow {
            per_project,
            recent,
            ..SessionWindow::new(SessionSort::Recent)
        }
    }

    #[test]
    fn each_project_keeps_its_newest_sessions_and_archived_ones_never_count() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut archived = item(a, "a-archived", 59);
        archived.status = TaskStatus::Cancelled;
        let live = vec![
            item(a, "a1", 1),
            item(a, "a2", 2),
            item(a, "a3", 3),
            archived,
            item(b, "b1", 1),
        ];
        let selected = window(2, 0).select(live);
        assert_eq!(titles(&selected), vec!["a2", "a3", "b1"]);
        assert!(
            selected
                .windows(2)
                .all(|pair| pair[0].updated_at >= pair[1].updated_at),
            "newest first"
        );
    }

    #[test]
    fn the_newest_sessions_across_projects_are_kept_beyond_the_project_rows() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let live = vec![
            item(a, "a1", 10),
            item(a, "a2", 20),
            item(a, "a3", 30),
            item(b, "b1", 1),
        ];
        assert_eq!(titles(&window(1, 2).select(live)), vec!["a2", "a3", "b1"]);
    }

    #[test]
    fn a_name_sort_also_keeps_the_first_names_of_each_project() {
        let a = Uuid::new_v4();
        let live = vec![item(a, "Zeta", 3), item(a, "alpha", 1), item(a, "Beta", 2)];
        let mut by_name = window(1, 0);
        by_name.sort = SessionSort::NameAscending;
        assert_eq!(titles(&by_name.select(live.clone())), vec!["Zeta", "alpha"]);
        by_name.sort = SessionSort::NameDescending;
        assert_eq!(titles(&by_name.select(live)), vec!["Zeta"]);
    }

    #[test]
    fn sessions_that_need_the_user_or_are_named_are_always_kept() {
        let a = Uuid::new_v4();
        let mut running = item(a, "running", 1);
        running.active_session_id = Some(Uuid::new_v4());
        let mut waiting = item(a, "waiting", 2);
        waiting.awaiting_input = true;
        let mut failed = item(a, "failed", 3);
        failed.status = TaskStatus::Failed;
        let pinned = item(a, "pinned", 4);
        let mut extended = window(1, 0);
        extended.include = HashSet::from([pinned.id]);
        let live = vec![
            running,
            waiting,
            failed,
            pinned,
            item(a, "old", 0),
            item(a, "newest", 9),
        ];
        assert_eq!(
            titles(&extended.select(live)),
            vec!["failed", "newest", "pinned", "running", "waiting"]
        );
    }

    #[test]
    fn show_more_extends_one_project() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut extended = window(1, 0);
        extended.project_limits = HashMap::from([(a, 2)]);
        let live = vec![
            item(a, "a1", 1),
            item(a, "a2", 2),
            item(a, "a3", 3),
            item(b, "b1", 1),
            item(b, "b2", 2),
        ];
        assert_eq!(titles(&extended.select(live)), vec!["a2", "a3", "b2"]);
    }

    #[test]
    fn delegation_trees_come_whole() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let root = item(a, "root", 1);
        let mut child = item(a, "child", 9);
        child.delegated_from_id = Some(root.id);
        let mut sibling = item(a, "sibling", 2);
        sibling.delegated_from_id = Some(root.id);
        let mut grandchild = item(a, "grandchild", 3);
        grandchild.delegated_from_id = Some(sibling.id);
        // A delegator in another project still names the delegated row.
        let mut across = item(b, "across", 8);
        across.delegated_from_id = Some(root.id);
        let unrelated = item(a, "unrelated", 0);
        let live = vec![
            root,
            child,
            sibling,
            grandchild,
            across,
            unrelated,
            item(b, "b-new", 10),
        ];
        assert_eq!(
            titles(&window(1, 0).select(live)),
            vec!["across", "b-new", "child", "grandchild", "root", "sibling"]
        );
    }

    #[test]
    fn a_delegation_cycle_ends() {
        let a = Uuid::new_v4();
        let mut first = item(a, "first", 2);
        let mut second = item(a, "second", 1);
        first.delegated_from_id = Some(second.id);
        second.delegated_from_id = Some(first.id);
        assert_eq!(
            titles(&window(1, 0).select(vec![first, second])),
            vec!["first", "second"]
        );
    }

    async fn migrated_pool() -> Pool<Sqlite> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn project(pool: &Pool<Sqlite>, path: &str, name: &str) -> ProjectRecord {
        ProjectRecord::ensure_with_name_hint(pool, path, Some(name))
            .await
            .unwrap()
    }

    async fn task(
        pool: &Pool<Sqlite>,
        project: &ProjectRecord,
        title: &str,
        minute: u32,
    ) -> TaskRecord {
        let mut task = TaskRecord::new(project.id, title, Some("a long description".repeat(100)));
        task.updated_at = at(minute);
        task.insert(pool).await.unwrap();
        // `insert` stores chrono's text; the app's own writes store SQLite's.
        sqlx::query("UPDATE task_records SET updated_at = ? WHERE id = ?")
            .bind(at(minute).format("%Y-%m-%d %H:%M:%S").to_string())
            .bind(task.id)
            .execute(pool)
            .await
            .unwrap();
        task
    }

    async fn archive(pool: &Pool<Sqlite>, task: &TaskRecord) {
        sqlx::query("UPDATE task_records SET status = 'cancelled' WHERE id = ?")
            .bind(task.id)
            .execute(pool)
            .await
            .unwrap();
    }

    fn page_titles(page: &SessionPage) -> Vec<&str> {
        page.sessions
            .iter()
            .map(|item| item.title.as_str())
            .collect()
    }

    #[tokio::test]
    async fn items_carry_the_record_fields_and_the_delegate_and_fork_edges() {
        let pool = migrated_pool().await;
        let repo = project(&pool, "/tmp/repo", "repo").await;
        let delegator = task(&pool, &repo, "delegator", 1).await;
        let delegated = task(&pool, &repo, "delegated", 2).await;
        TaskContextRef::insert_for_task(
            &pool,
            delegated.id,
            None,
            None,
            &TaskContextRefInput::delegate(delegator.id, Some("delegator".into())),
            0,
        )
        .await
        .unwrap();

        let live = SessionListItem::list_live(&pool).await.unwrap();
        let item = live.iter().find(|item| item.id == delegated.id).unwrap();
        let record = TaskRecord::get(&pool, delegated.id).await.unwrap();
        assert_eq!(item, &SessionListItem::from(record));
        assert_eq!(item.delegated_from_id, Some(delegator.id));

        let mut keys: Vec<String> = serde_json::to_value(item)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "active_session_id",
                "awaiting_input",
                "branch",
                "delegated_from_id",
                "forked_from_title",
                "id",
                "last_executor",
                "last_summary",
                "note",
                "project_id",
                "status",
                "title",
                "updated_at",
                "worktree_deleted",
            ],
            "exactly the fields the phone reads"
        );
    }

    #[tokio::test]
    async fn live_sessions_and_counts_leave_archived_ones_out() {
        let pool = migrated_pool().await;
        let repo = project(&pool, "/tmp/repo", "repo").await;
        let other = project(&pool, "/tmp/other", "other").await;
        task(&pool, &repo, "kept", 1).await;
        let gone = task(&pool, &repo, "archived", 2).await;
        archive(&pool, &gone).await;
        task(&pool, &other, "elsewhere", 3).await;

        let live = SessionListItem::list_live(&pool).await.unwrap();
        let mut live_titles: Vec<&str> = live.iter().map(|item| item.title.as_str()).collect();
        live_titles.sort_unstable();
        assert_eq!(live_titles, vec!["elsewhere", "kept"]);

        let counts = SessionListItem::counts(&pool).await.unwrap();
        assert_eq!(
            counts[&repo.id],
            SessionCounts {
                live: 1,
                archived: 1
            }
        );
        assert_eq!(
            counts[&other.id],
            SessionCounts {
                live: 1,
                archived: 0
            }
        );
    }

    #[tokio::test]
    async fn queries_page_in_the_list_order() {
        let pool = migrated_pool().await;
        let repo = project(&pool, "/tmp/repo", "repo").await;
        for (minute, title) in [(1, "b"), (2, "C"), (3, "a"), (4, "d")] {
            task(&pool, &repo, title, minute).await;
        }
        let mut query = SessionQuery {
            project_id: Some(repo.id),
            limit: 2,
            ..SessionQuery::default()
        };
        let first = SessionListItem::query(&pool, &query).await.unwrap();
        assert_eq!((page_titles(&first), first.total), (vec!["d", "a"], 4));
        query.offset = 2;
        let second = SessionListItem::query(&pool, &query).await.unwrap();
        assert_eq!(page_titles(&second), vec!["C", "b"]);

        query.offset = 0;
        query.limit = 10;
        query.sort = SessionSort::NameAscending;
        assert_eq!(
            page_titles(&SessionListItem::query(&pool, &query).await.unwrap()),
            vec!["a", "b", "C", "d"]
        );
        query.sort = SessionSort::NameDescending;
        assert_eq!(
            page_titles(&SessionListItem::query(&pool, &query).await.unwrap()),
            vec!["d", "C", "b", "a"]
        );
    }

    #[tokio::test]
    async fn queries_search_titles_and_project_names_literally() {
        let pool = migrated_pool().await;
        let repo = project(&pool, "/tmp/repo", "Website").await;
        let other = project(&pool, "/tmp/other", "tools").await;
        task(&pool, &repo, "Fix login", 1).await;
        task(&pool, &other, "100% coverage", 2).await;
        task(&pool, &other, "1000 coverage", 3).await;
        let archived = task(&pool, &other, "login archive", 4).await;
        archive(&pool, &archived).await;

        let search = |text: &str| SessionQuery {
            text: Some(text.into()),
            limit: 10,
            ..SessionQuery::default()
        };
        let found = SessionListItem::query(&pool, &search("LOGIN"))
            .await
            .unwrap();
        assert_eq!(
            page_titles(&found),
            vec!["Fix login"],
            "case-insensitive, live only"
        );
        let found = SessionListItem::query(&pool, &search("web")).await.unwrap();
        assert_eq!(page_titles(&found), vec!["Fix login"], "by project name");
        let found = SessionListItem::query(&pool, &search("100%"))
            .await
            .unwrap();
        assert_eq!(
            page_titles(&found),
            vec!["100% coverage"],
            "wildcards are literal"
        );
    }

    #[tokio::test]
    async fn queries_read_the_archive_and_named_sessions() {
        let pool = migrated_pool().await;
        let repo = project(&pool, "/tmp/repo", "repo").await;
        let live = task(&pool, &repo, "live", 1).await;
        let old = task(&pool, &repo, "old", 2).await;
        archive(&pool, &old).await;

        let archived = SessionListItem::query(
            &pool,
            &SessionQuery {
                project_id: Some(repo.id),
                archived: true,
                limit: 10,
                ..SessionQuery::default()
            },
        )
        .await
        .unwrap();
        assert_eq!((page_titles(&archived), archived.total), (vec!["old"], 1));

        let named = SessionListItem::query(
            &pool,
            &SessionQuery {
                ids: vec![live.id, old.id],
                limit: 10,
                ..SessionQuery::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page_titles(&named), vec!["live"], "named, live only");
    }
}
