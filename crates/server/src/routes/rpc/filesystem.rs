//! Filesystem API routes for directory browsing.

use axum::{extract::Query, routing::get, Json, Router};
use filesystem::{DirectoryListResponse, FilesystemError, FilesystemService};
use serde::{Deserialize, Serialize};

use crate::{ApiError, AppState};

#[derive(Debug, Deserialize)]
pub struct ListDirectoryQuery {
    path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CurrentDirectoryResponse {
    path: String,
}

async fn list_directory(
    Query(query): Query<ListDirectoryQuery>,
) -> Result<Json<DirectoryListResponse>, ApiError> {
    let fs_service = FilesystemService::new();
    let response = fs_service.list_directory(query.path)?;
    Ok(Json(response))
}

async fn current_directory() -> Result<Json<CurrentDirectoryResponse>, ApiError> {
    let cwd = std::env::current_dir().map_err(FilesystemError::Io)?;
    Ok(Json(CurrentDirectoryResponse {
        path: cwd.to_string_lossy().to_string(),
    }))
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/filesystem/directory", get(list_directory))
        .route("/filesystem/cwd", get(current_directory))
}
