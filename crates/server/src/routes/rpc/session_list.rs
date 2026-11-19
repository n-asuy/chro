//! The phone's session list: the window its stream holds
//! (`/streams/session-list`) and the paged lookups outside it
//! (`GET /rpc/session-list`). See `db::models::session_list`.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Query, State},
    routing::get,
    Json, Router,
};
use db::models::{SessionListItem, SessionPage, SessionQuery, SessionSort, SessionWindow};
use uuid::Uuid;

use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/session-list", get(query_sessions))
}

/// One page of live or archived sessions: "Show more" (`project_id`,
/// `offset`), search (`q`), the archive (`archived=true`) and sessions named
/// by id (`ids`, comma-separated).
async fn query_sessions(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<SessionPage>, ApiError> {
    let query = query_from_params(&params)?;
    Ok(Json(SessionListItem::query(state.pool(), &query).await?))
}

fn query_from_params(params: &HashMap<String, String>) -> Result<SessionQuery, ApiError> {
    let ids = params
        .get("ids")
        .map(|raw| uuids("ids", raw))
        .transpose()?
        .unwrap_or_default();
    if ids.len() > SessionQuery::MAX_LIMIT {
        return Err(bad(format!(
            "ids names at most {} sessions",
            SessionQuery::MAX_LIMIT
        )));
    }
    Ok(SessionQuery {
        project_id: params
            .get("project_id")
            .map(|raw| uuid("project_id", raw))
            .transpose()?,
        archived: flag(params, "archived")?,
        text: params
            .get("q")
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty()),
        ids,
        sort: sort(params)?,
        offset: number(params, "offset", 0, usize::MAX)?,
        limit: number(
            params,
            "limit",
            SessionQuery::DEFAULT_LIMIT,
            SessionQuery::MAX_LIMIT,
        )?,
    })
}

/// The stream's window: `sort`, `limit` (rows per project), `project_limits`
/// (`<project id>:<rows>`, comma-separated) and `include` (session ids,
/// comma-separated).
pub(crate) fn window_from_params(
    params: &HashMap<String, String>,
) -> Result<SessionWindow, ApiError> {
    let mut window = SessionWindow::new(sort(params)?);
    window.per_project = number(
        params,
        "limit",
        SessionWindow::DEFAULT_PER_PROJECT,
        SessionWindow::MAX_PER_PROJECT,
    )?;
    if let Some(raw) = params.get("project_limits") {
        for entry in raw.split(',').filter(|entry| !entry.is_empty()) {
            let (project_id, rows) = entry.split_once(':').ok_or_else(|| {
                bad(format!(
                    "project_limits entry {entry:?} is not <project id>:<rows>"
                ))
            })?;
            let rows = rows
                .parse::<usize>()
                .ok()
                .filter(|rows| (1..=SessionWindow::MAX_PER_PROJECT).contains(rows))
                .ok_or_else(|| {
                    bad(format!(
                        "project_limits rows {rows:?} must be 1..={}",
                        SessionWindow::MAX_PER_PROJECT
                    ))
                })?;
            window
                .project_limits
                .insert(uuid("project_limits", project_id)?, rows);
        }
    }
    if let Some(raw) = params.get("include") {
        window.include = uuids("include", raw)?.into_iter().collect::<HashSet<_>>();
        if window.include.len() > SessionWindow::MAX_INCLUDED {
            return Err(bad(format!(
                "include names at most {} sessions",
                SessionWindow::MAX_INCLUDED
            )));
        }
    }
    Ok(window)
}

fn bad(message: String) -> ApiError {
    ApiError::BadRequest(message)
}

fn uuid(name: &str, raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| bad(format!("{name}: {raw:?} is not an id")))
}

fn uuids(name: &str, raw: &str) -> Result<Vec<Uuid>, ApiError> {
    raw.split(',')
        .filter(|id| !id.is_empty())
        .map(|id| uuid(name, id))
        .collect()
}

fn sort(params: &HashMap<String, String>) -> Result<SessionSort, ApiError> {
    match params.get("sort") {
        None => Ok(SessionSort::Recent),
        Some(raw) => SessionSort::parse(raw).ok_or_else(|| {
            bad(format!(
                "sort must be recent, name-asc or name-desc, not {raw:?}"
            ))
        }),
    }
}

fn flag(params: &HashMap<String, String>, name: &str) -> Result<bool, ApiError> {
    match params.get(name).map(String::as_str) {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(other) => Err(bad(format!("{name} must be true or false, not {other:?}"))),
    }
}

fn number(
    params: &HashMap<String, String>,
    name: &str,
    default: usize,
    max: usize,
) -> Result<usize, ApiError> {
    match params.get(name) {
        None => Ok(default),
        Some(raw) => raw
            .parse::<usize>()
            .ok()
            .filter(|value| *value <= max && (name == "offset" || *value >= 1))
            .ok_or_else(|| bad(format!("{name} must be a number up to {max}, not {raw:?}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(name, value)| (name.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn a_window_reads_its_parameters() {
        let (project, pinned) = (Uuid::new_v4(), Uuid::new_v4());
        let window = window_from_params(&params(&[
            ("sort", "name-desc"),
            ("limit", "12"),
            ("project_limits", &format!("{project}:40")),
            ("include", &format!("{pinned},")),
        ]))
        .unwrap();
        assert_eq!(window.sort, SessionSort::NameDescending);
        assert_eq!(window.per_project, 12);
        assert_eq!(window.project_limits, HashMap::from([(project, 40)]));
        assert_eq!(window.include, HashSet::from([pinned]));
        assert_eq!(
            window_from_params(&HashMap::new()).unwrap(),
            SessionWindow::new(SessionSort::Recent)
        );
    }

    #[test]
    fn a_window_refuses_malformed_parameters() {
        for bad in [
            params(&[("sort", "oldest")]),
            params(&[("limit", "0")]),
            params(&[("limit", "1001")]),
            params(&[("project_limits", "not-an-id:3")]),
            params(&[("project_limits", &format!("{}", Uuid::new_v4()))]),
            params(&[("include", "nope")]),
        ] {
            assert!(
                matches!(window_from_params(&bad), Err(ApiError::BadRequest(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_query_reads_its_parameters() {
        let (project, id) = (Uuid::new_v4(), Uuid::new_v4());
        let query = query_from_params(&params(&[
            ("project_id", &project.to_string()),
            ("archived", "true"),
            ("q", "  login "),
            ("ids", &id.to_string()),
            ("sort", "name-asc"),
            ("offset", "20"),
            ("limit", "30"),
        ]))
        .unwrap();
        assert_eq!(
            query,
            SessionQuery {
                project_id: Some(project),
                archived: true,
                text: Some("login".into()),
                ids: vec![id],
                sort: SessionSort::NameAscending,
                offset: 20,
                limit: 30,
            }
        );
        let defaults = query_from_params(&HashMap::new()).unwrap();
        assert_eq!(defaults.limit, SessionQuery::DEFAULT_LIMIT);
        assert!(matches!(
            query_from_params(&params(&[("limit", "201")])),
            Err(ApiError::BadRequest(_))
        ));
        assert!(matches!(
            query_from_params(&params(&[("archived", "yes")])),
            Err(ApiError::BadRequest(_))
        ));
    }
}
