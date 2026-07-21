//! `.cbase` view endpoints.
//!
//! `query` parses a `.cbase`, indexes matching workspace files, and returns the
//! materialized view document. `persist` writes UI-driven changes back to the
//! file and returns the refreshed document. All parsing, indexing, and
//! execution live in the `cbase` crate; these handlers only resolve the project
//! path and bridge file I/O.

use std::path::PathBuf;

use axum::{
    extract::{Path, State},
    routing::post,
    Json, Router,
};
use cbase::{CbaseDocument, CbaseError, PersistInput};
use db::models::ProjectRecord;
use runtime::ProjectFileService;
use serde::{Deserialize, Serialize};

use super::path_resolve::require_internal;
use crate::{ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/projects/:project_id/cbase/query", post(query_cbase))
        .route("/projects/:project_id/cbase/persist", post(persist_cbase))
        .route(
            "/projects/:project_id/cbase/set-property",
            post(set_cbase_property),
        )
}

async fn resolve_project_path(state: &AppState, identifier: &str) -> Result<PathBuf, ApiError> {
    let project = ProjectRecord::get_by_identifier(state.pool(), identifier).await?;
    Ok(PathBuf::from(&project.git_repo_path))
}

/// Indexing walks the filesystem synchronously; keep it off the async workers.
/// The shared index cache re-reads only files whose mtime changed since the
/// last query, so repeated queries (tab re-activation) stay cheap.
async fn run_query(
    state: &AppState,
    root: PathBuf,
    content: String,
    base_path: Option<String>,
) -> Result<CbaseDocument, ApiError> {
    let cache = state.cbase_index().clone();
    tokio::task::spawn_blocking(move || {
        cbase::query_cached(&root, &content, base_path.as_deref(), &cache)
    })
    .await
    .map_err(|err| ApiError::Internal(err.to_string()))?
    .map_err(map_cbase_error)
}

/// Parse failures are returned in-band on the document, so any error here is an
/// I/O failure during indexing.
fn map_cbase_error(error: CbaseError) -> ApiError {
    match error {
        CbaseError::Io(err) => ApiError::Internal(err.to_string()),
        CbaseError::Parse(message) => ApiError::BadRequest(message),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CbaseQueryRequest {
    content: String,
    #[serde(default)]
    base_path: Option<String>,
}

async fn query_cbase(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CbaseQueryRequest>,
) -> Result<Json<CbaseDocument>, ApiError> {
    let project_path = resolve_project_path(&state, &project_id).await?;
    let document = run_query(&state, project_path, request.content, request.base_path).await?;
    Ok(Json(document))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CbasePersistResponse {
    content: String,
    document: CbaseDocument,
}

async fn persist_cbase(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(input): Json<PersistInput>,
) -> Result<Json<CbasePersistResponse>, ApiError> {
    if input.base_path.trim().is_empty() {
        return Err(ApiError::BadRequest("basePath is required".into()));
    }

    let project_path = resolve_project_path(&state, &project_id).await?;
    let project_root = project_path.to_string_lossy().to_string();

    let content = cbase::prepare_persist(&input).map_err(map_cbase_error)?;
    let resolved = require_internal(&input.base_path, &project_root)?;
    ProjectFileService::new(state.runtime(), project_path.clone())
        .write_file(&resolved, &content)
        .await?;

    let document = run_query(&state, project_path, content.clone(), Some(input.base_path)).await?;
    Ok(Json(CbasePersistResponse { content, document }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetPropertyRequest {
    /// Relative path of the row's markdown file.
    file_path: String,
    /// Frontmatter key to write.
    key: String,
    /// New value; `null` removes the key.
    value: serde_json::Value,
}

/// Rewrite one frontmatter property of a row file. The UI applies the change
/// optimistically; the worktree watcher event triggers the re-query that
/// settles the table, so no document is returned here.
async fn set_cbase_property(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<SetPropertyRequest>,
) -> Result<axum::http::StatusCode, ApiError> {
    if request.file_path.trim().is_empty() {
        return Err(ApiError::BadRequest("filePath is required".into()));
    }
    if request.key.trim().is_empty() {
        return Err(ApiError::BadRequest("key is required".into()));
    }

    let project_path = resolve_project_path(&state, &project_id).await?;
    let project_root = project_path.to_string_lossy().to_string();
    let resolved = require_internal(&request.file_path, &project_root)?;

    let absolute = project_path.join(&resolved);
    let content = tokio::task::spawn_blocking(move || std::fs::read_to_string(absolute))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))?
        .map_err(|err| ApiError::Internal(err.to_string()))?;

    let updated = cbase::set_frontmatter_property(&content, &request.key, &request.value)
        .map_err(map_cbase_error)?;

    ProjectFileService::new(state.runtime(), project_path)
        .write_file(&resolved, &updated)
        .await?;

    Ok(axum::http::StatusCode::NO_CONTENT)
}
