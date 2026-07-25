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

const DEFAULT_CBASE_PAGE_SIZE: usize = 250;
const MAX_CBASE_PAGE_SIZE: usize = 1_000;
const MAX_CBASE_DEFINITION_BYTES: usize = 512 * 1024;

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
    view_id: Option<String>,
    offset: usize,
    limit: usize,
) -> Result<CbaseDocument, ApiError> {
    let cache = state.cbase_index().clone();
    let permit = state
        .cbase_query_semaphore()
        .clone()
        .acquire_owned()
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        cbase::query_cached_page(
            &root,
            &content,
            base_path.as_deref(),
            &cache,
            view_id.as_deref(),
            offset,
            limit,
        )
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
    #[serde(default)]
    view_id: Option<String>,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn query_cbase(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(request): Json<CbaseQueryRequest>,
) -> Result<Json<CbaseDocument>, ApiError> {
    if request.content.len() > MAX_CBASE_DEFINITION_BYTES {
        return Err(ApiError::BadRequest(
            ".cbase definition exceeds the 512 KiB safety limit".into(),
        ));
    }
    let project_path = resolve_project_path(&state, &project_id).await?;
    // Offset is only used to slice an already bounded row-reference vector;
    // keeping the caller's value avoids duplicate pages for very large views.
    let offset = request.offset.unwrap_or(0);
    let limit = request
        .limit
        .unwrap_or(DEFAULT_CBASE_PAGE_SIZE)
        .clamp(1, MAX_CBASE_PAGE_SIZE);
    let document = run_query(
        &state,
        project_path,
        request.content,
        request.base_path,
        request.view_id,
        offset,
        limit,
    )
    .await?;
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

    let view_id = input.view_id.clone();
    let document = run_query(
        &state,
        project_path,
        content.clone(),
        Some(input.base_path),
        view_id,
        0,
        DEFAULT_CBASE_PAGE_SIZE,
    )
    .await?;
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
