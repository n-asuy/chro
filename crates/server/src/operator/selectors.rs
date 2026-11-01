//! Turning the selectors people and agents type into stored objects.
//!
//! Session: `self`, `parent`, a full id, a slug, or a unique slug prefix.
//! Project: a full id, a slug, a unique slug prefix, or `path:<dir>`.
//! `self` and `parent` come from the caller's token, so an agent can say
//! "me" without knowing its own id and cannot claim to be someone else.

use db::models::{ProjectRecord, TaskContextRef, TaskRecord};
use server_contract::ErrorCode;
use sqlx::{Pool, Sqlite};
use uuid::Uuid;

use super::{Caller, V1Error};

/// Shortest prefix accepted in place of a full slug.
const MIN_PREFIX: usize = 3;
/// Candidates reported for an ambiguous prefix.
const MAX_CANDIDATES: i64 = 8;

#[derive(Debug, PartialEq, Eq)]
enum Selector<'a> {
    Myself,
    Parent,
    Id(Uuid),
    Path(&'a str),
    Slug(&'a str),
}

fn parse(raw: &str) -> Result<Selector<'_>, V1Error> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(V1Error::new(ErrorCode::InvalidSelector, "empty selector"));
    }
    if raw == "self" {
        return Ok(Selector::Myself);
    }
    if raw == "parent" {
        return Ok(Selector::Parent);
    }
    if let Some(path) = raw.strip_prefix("path:") {
        return Ok(Selector::Path(path));
    }
    if let Ok(id) = Uuid::parse_str(raw) {
        return Ok(Selector::Id(id));
    }
    if raw.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(Selector::Slug(raw));
    }
    Err(V1Error::new(
        ErrorCode::InvalidSelector,
        format!("'{raw}' is not an id, a slug, self, parent, or path:<dir>"),
    ))
}

/// Resolve a session selector for `caller`.
pub(crate) async fn session(
    pool: &Pool<Sqlite>,
    caller: Caller,
    raw: &str,
) -> Result<TaskRecord, V1Error> {
    match parse(raw)? {
        Selector::Myself => own_session(pool, caller).await,
        Selector::Parent => {
            let own = own_session(pool, caller).await?;
            let parent_id = TaskContextRef::list_by_task_id(pool, own.id)
                .await?
                .into_iter()
                .find(|edge| edge.kind == "delegate")
                .and_then(|edge| edge.target_task_id)
                .ok_or_else(|| {
                    V1Error::new(
                        ErrorCode::NotFound,
                        "this session was not delegated, so it has no parent",
                    )
                })?;
            find_task(pool, parent_id).await
        }
        Selector::Id(id) => find_task(pool, id).await,
        Selector::Slug(slug) => {
            let id = by_slug(pool, "task_records", slug, "session").await?;
            find_task(pool, id).await
        }
        Selector::Path(_) => Err(V1Error::new(
            ErrorCode::InvalidSelector,
            "path: selects a project, not a session",
        )),
    }
}

/// Resolve a project selector. `path:` finds a registered project only; use
/// [`project_ensuring`] where an unknown path should be registered.
pub(crate) async fn project(pool: &Pool<Sqlite>, raw: &str) -> Result<ProjectRecord, V1Error> {
    match parse(raw)? {
        Selector::Id(id) => find_project(pool, id).await,
        Selector::Slug(slug) => {
            let id = by_slug(pool, "project_records", slug, "project").await?;
            find_project(pool, id).await
        }
        Selector::Path(path) => {
            let canonical = canonical(path)?;
            registered_at(pool, path, &canonical).await?.ok_or_else(|| {
                V1Error::not_found(format!("project at {canonical}"))
                    .with_next(format!("chro project add {canonical}"))
            })
        }
        Selector::Myself | Selector::Parent => Err(V1Error::new(
            ErrorCode::InvalidSelector,
            "self and parent select sessions, not projects",
        )),
    }
}

/// Like [`project`], but registers an unknown `path:` as a new project.
pub(crate) async fn project_ensuring(
    pool: &Pool<Sqlite>,
    raw: &str,
) -> Result<ProjectRecord, V1Error> {
    match parse(raw)? {
        Selector::Path(path) => {
            let canonical = canonical(path)?;
            if let Some(existing) = registered_at(pool, path, &canonical).await? {
                return Ok(existing);
            }
            Ok(ProjectRecord::ensure_with_name_hint(pool, &canonical, None).await?)
        }
        _ => project(pool, raw).await,
    }
}

/// A project registered under either spelling of a path. Projects added from
/// a folder picker keep the path as the user saw it (`/tmp/x`), while the CLI
/// sends what git reports (`/private/tmp/x`); both must find the same project.
async fn registered_at(
    pool: &Pool<Sqlite>,
    raw: &str,
    canonical: &str,
) -> Result<Option<ProjectRecord>, V1Error> {
    let raw = raw.trim().trim_end_matches(['/', '\\']);
    for candidate in [raw, canonical] {
        if let Some(project) = ProjectRecord::find_by_git_repo_path(pool, candidate).await? {
            return Ok(Some(project));
        }
    }
    Ok(None)
}

fn canonical(path: &str) -> Result<String, V1Error> {
    let path = path.trim();
    if path.is_empty() || !std::path::Path::new(path).is_absolute() {
        return Err(V1Error::new(
            ErrorCode::InvalidSelector,
            format!("path:{path} must be an absolute path"),
        ));
    }
    let resolved = dunce::canonicalize(path)
        .map_err(|err| V1Error::new(ErrorCode::NotFound, format!("{path}: {err}")))?;
    Ok(resolved.to_string_lossy().into_owned())
}

async fn own_session(pool: &Pool<Sqlite>, caller: Caller) -> Result<TaskRecord, V1Error> {
    match caller {
        Caller::Agent { task_id, .. } => find_task(pool, task_id).await,
        Caller::User => Err(V1Error::new(
            ErrorCode::InvalidSelector,
            "self and parent only mean something inside a chro session; name the session instead",
        )
        .with_next("chro session list")),
    }
}

async fn find_project(pool: &Pool<Sqlite>, id: Uuid) -> Result<ProjectRecord, V1Error> {
    match ProjectRecord::get(pool, id).await {
        Ok(project) => Ok(project),
        Err(sqlx::Error::RowNotFound) => Err(V1Error::not_found(format!("project {id}"))),
        Err(err) => Err(err.into()),
    }
}

async fn find_task(pool: &Pool<Sqlite>, id: Uuid) -> Result<TaskRecord, V1Error> {
    TaskRecord::find_by_id(pool, id)
        .await?
        .ok_or_else(|| V1Error::not_found(format!("session {id}")))
}

/// A message in a session's queue (`queue`, oldest first) by full id or a
/// unique, case-insensitive prefix of at least [`MIN_PREFIX`] characters.
pub(crate) fn queued_message(queue: &[Uuid], selector: &str) -> Result<Uuid, V1Error> {
    let selector = selector.trim().to_ascii_lowercase();
    let not_found = || {
        V1Error::not_found(format!(
            "queued message {selector}; it may have started or been withdrawn already"
        ))
    };
    if selector.len() < MIN_PREFIX {
        return Err(not_found());
    }
    let matches: Vec<Uuid> = queue
        .iter()
        .copied()
        .filter(|id| id.to_string().starts_with(&selector))
        .collect();
    match matches.as_slice() {
        [] => Err(not_found()),
        [id] => Ok(*id),
        many => Err(V1Error(
            server_contract::ErrorBody::new(
                ErrorCode::Ambiguous,
                format!("{selector} matches more than one queued message"),
            )
            .with_candidates(many.iter().map(Uuid::to_string).collect()),
        )),
    }
}

/// Exact slug, else a unique prefix of at least [`MIN_PREFIX`] characters.
async fn by_slug(
    pool: &Pool<Sqlite>,
    table: &'static str,
    slug: &str,
    noun: &str,
) -> Result<Uuid, V1Error> {
    let exact: Option<Uuid> = sqlx::query_scalar(&format!("SELECT id FROM {table} WHERE slug = ?"))
        .bind(slug)
        .fetch_optional(pool)
        .await?;
    if let Some(id) = exact {
        return Ok(id);
    }
    if slug.len() < MIN_PREFIX {
        return Err(V1Error::not_found(format!("{noun} {slug}")));
    }
    // `slug` is alphanumeric (checked in `parse`), so it carries no LIKE
    // wildcards.
    let matches: Vec<(Uuid, String)> = sqlx::query_as(&format!(
        "SELECT id, slug FROM {table} WHERE slug LIKE ? ORDER BY slug LIMIT ?"
    ))
    .bind(format!("{slug}%"))
    .bind(MAX_CANDIDATES)
    .fetch_all(pool)
    .await?;
    match matches.as_slice() {
        [] => Err(V1Error::not_found(format!("{noun} {slug}"))),
        [(id, _)] => Ok(*id),
        many => Err(V1Error(
            server_contract::ErrorBody::new(
                ErrorCode::Ambiguous,
                format!("{slug} matches more than one {noun}"),
            )
            .with_candidates(many.iter().map(|(_, slug)| slug.clone()).collect()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_queued_message_is_picked_by_id_or_unique_prefix() {
        let a = Uuid::parse_str("5f932ea7-0b7d-4add-9501-aa3d1527e551").unwrap();
        let b = Uuid::parse_str("5f94aaaa-0b7d-4add-9501-aa3d1527e551").unwrap();
        let queue = [a, b];
        assert_eq!(queued_message(&queue, &a.to_string()).unwrap(), a);
        assert_eq!(queued_message(&queue, "5f932").unwrap(), a);
        assert_eq!(queued_message(&queue, "5F94").unwrap(), b);

        let err = queued_message(&queue, "5f9").unwrap_err();
        assert_eq!(err.0.code, ErrorCode::Ambiguous);
        assert_eq!(err.0.candidates.len(), 2);
        assert_eq!(
            queued_message(&queue, "5f").unwrap_err().0.code,
            ErrorCode::NotFound
        );
        assert_eq!(
            queued_message(&queue, "ffff").unwrap_err().0.code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn parses_every_selector_form() {
        let id = Uuid::new_v4();
        assert_eq!(parse("self").unwrap(), Selector::Myself);
        assert_eq!(parse("parent").unwrap(), Selector::Parent);
        assert_eq!(parse(&id.to_string()).unwrap(), Selector::Id(id));
        assert_eq!(parse("ab12cd34").unwrap(), Selector::Slug("ab12cd34"));
        assert_eq!(parse("path:/repo").unwrap(), Selector::Path("/repo"));
    }

    #[test]
    fn rejects_selectors_that_could_smuggle_sql_wildcards() {
        for raw in ["", "ab%", "a_b", "x y"] {
            assert_eq!(
                parse(raw).unwrap_err().0.code,
                ErrorCode::InvalidSelector,
                "{raw:?}"
            );
        }
    }

    #[tokio::test]
    async fn self_means_nothing_to_the_user() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::DBService::new_with_path(&dir.path().join("t.db"))
            .await
            .unwrap();
        let err = session(db.pool(), Caller::User, "self").await.unwrap_err();
        assert_eq!(err.0.code, ErrorCode::InvalidSelector);
    }

    #[tokio::test]
    async fn slugs_resolve_exactly_then_by_unique_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::DBService::new_with_path(&dir.path().join("t.db"))
            .await
            .unwrap();
        let pool = db.pool();
        let project = ProjectRecord::ensure_with_name_hint(pool, "/tmp/sel-repo", None)
            .await
            .unwrap();
        let mut ids = Vec::new();
        for slug in ["abc111", "abc222", "zzz999"] {
            let task = TaskRecord::new(project.id, slug, None);
            task.insert(pool).await.unwrap();
            sqlx::query("UPDATE task_records SET slug = ? WHERE id = ?")
                .bind(slug)
                .bind(task.id)
                .execute(pool)
                .await
                .unwrap();
            ids.push(task.id);
        }

        let exact = session(pool, Caller::User, "abc222").await.unwrap();
        assert_eq!(exact.id, ids[1]);
        let prefix = session(pool, Caller::User, "zzz").await.unwrap();
        assert_eq!(prefix.id, ids[2]);

        let err = session(pool, Caller::User, "abc").await.unwrap_err();
        assert_eq!(err.0.code, ErrorCode::Ambiguous);
        assert_eq!(err.0.candidates, vec!["abc111", "abc222"]);

        let err = session(pool, Caller::User, "ab").await.unwrap_err();
        assert_eq!(err.0.code, ErrorCode::NotFound, "too short to be a prefix");
    }

    #[tokio::test]
    async fn self_and_parent_follow_the_callers_token() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::DBService::new_with_path(&dir.path().join("t.db"))
            .await
            .unwrap();
        let pool = db.pool();
        let project = ProjectRecord::ensure_with_name_hint(pool, "/tmp/sel-repo2", None)
            .await
            .unwrap();
        let parent = TaskRecord::new(project.id, "parent", None);
        parent.insert(pool).await.unwrap();
        let child = TaskRecord::new(project.id, "child", None);
        child.insert(pool).await.unwrap();
        TaskContextRef::insert_for_task(
            pool,
            child.id,
            None,
            None,
            &db::models::TaskContextRefInput::delegate(parent.id, Some("parent".into())),
            0,
        )
        .await
        .unwrap();

        let caller = Caller::Agent {
            task_id: child.id,
            run_id: Uuid::new_v4(),
        };
        assert_eq!(session(pool, caller, "self").await.unwrap().id, child.id);
        assert_eq!(session(pool, caller, "parent").await.unwrap().id, parent.id);

        let orphan = Caller::Agent {
            task_id: parent.id,
            run_id: Uuid::new_v4(),
        };
        assert_eq!(
            session(pool, orphan, "parent").await.unwrap_err().0.code,
            ErrorCode::NotFound
        );
    }
}
