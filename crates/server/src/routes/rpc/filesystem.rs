//! Filesystem API routes for directory browsing.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use filesystem::{
    DirectoryListResponse, FilesystemError, FilesystemService, WorkspaceEntry,
    WorkspaceEntryDetail, WorkspaceEntryType, WorkspaceFile,
};
use runtime::ProjectFileService;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::path_resolve::{read_binary_resolving, read_text_resolving};
use crate::{format_system_time, ApiError, AppState};

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

#[derive(Debug, Deserialize)]
struct WorkspaceEntriesQuery {
    /// Absolute path to the workspace root being listed (e.g. an additional
    /// folder added to the project via "Add Folder to Project").
    abs_path: String,
    relative_path: Option<String>,
    #[serde(default)]
    recursive: bool,
    /// Entry payload detail level: "basic" | "full" (default: "full").
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkspaceFileQuery {
    /// Absolute path to the workspace root containing the file.
    abs_path: String,
    /// Path to the file relative to `abs_path`.
    relative_path: String,
}

#[derive(Debug, Serialize)]
struct WorkspaceEntriesEnvelope {
    entries: Vec<WorkspaceEntryResponse>,
}

#[derive(Debug, Serialize)]
struct WorkspaceFileEnvelope {
    file: WorkspaceFileResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntryResponse {
    r#type: String,
    name: String,
    display_name: String,
    relative_path: String,
    extension: Option<String>,
    has_children: Option<bool>,
    size: Option<u64>,
    modified_at: Option<String>,
    created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<WorkspaceEntryResponse>>,
}

#[derive(Debug, Serialize)]
struct WorkspaceFileResponse {
    relative_path: String,
    content: String,
    size: u64,
    modified_at: Option<String>,
}

impl From<WorkspaceEntry> for WorkspaceEntryResponse {
    fn from(entry: WorkspaceEntry) -> Self {
        Self {
            r#type: match entry.entry_type {
                WorkspaceEntryType::Directory => "directory".into(),
                WorkspaceEntryType::File => "file".into(),
            },
            name: entry.name,
            display_name: entry.display_name,
            relative_path: entry.relative_path,
            extension: entry.extension,
            has_children: entry.has_children,
            size: entry.size,
            modified_at: format_system_time(entry.modified),
            created_at: format_system_time(entry.created),
            children: entry
                .children
                .map(|c| c.into_iter().map(WorkspaceEntryResponse::from).collect()),
        }
    }
}

impl From<WorkspaceFile> for WorkspaceFileResponse {
    fn from(file: WorkspaceFile) -> Self {
        Self {
            relative_path: file.relative_path,
            content: file.content,
            size: file.size,
            modified_at: format_system_time(file.modified),
        }
    }
}

fn resolve_workspace_root(abs_path: &str) -> Result<PathBuf, ApiError> {
    let trimmed = abs_path.trim();
    if trimmed.is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'abs_path' is required".into(),
        ));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(ApiError::BadRequest(
            "query parameter 'abs_path' must be an absolute path".into(),
        ));
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|_| ApiError::BadRequest("'abs_path' does not exist".into()))?;
    if !metadata.is_dir() {
        return Err(ApiError::BadRequest(
            "'abs_path' must point to a directory".into(),
        ));
    }
    Ok(path)
}

/// List entries of any absolute filesystem path. Mirrors the project-scoped
/// `/projects/{id}/entries` endpoint but takes an explicit absolute path so
/// that ad-hoc workspace folders ("worktrees") can be browsed independently
/// of the bound project. The path must exist and be a directory.
async fn list_workspace_entries(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceEntriesQuery>,
) -> Result<Json<WorkspaceEntriesEnvelope>, ApiError> {
    let abs_path = resolve_workspace_root(&query.abs_path)?;

    let detail = match query.detail.as_deref() {
        None => WorkspaceEntryDetail::Full,
        Some("basic") => WorkspaceEntryDetail::Basic,
        Some("full") => WorkspaceEntryDetail::Full,
        Some(_) => {
            return Err(ApiError::BadRequest(
                "query parameter 'detail' must be 'basic' or 'full'".into(),
            ));
        }
    };

    let service = ProjectFileService::new(state.runtime(), abs_path);
    let entries = if query.recursive {
        service
            .list_entries_recursive(query.relative_path.as_deref(), detail)
            .await?
    } else {
        service
            .list_entries(query.relative_path.as_deref(), detail)
            .await?
    };

    Ok(Json(WorkspaceEntriesEnvelope {
        entries: entries
            .into_iter()
            .map(WorkspaceEntryResponse::from)
            .collect(),
    }))
}

/// Read a text file from any absolute workspace root.
async fn read_workspace_file(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceFileQuery>,
) -> Result<Json<WorkspaceFileEnvelope>, ApiError> {
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let abs_path = resolve_workspace_root(&query.abs_path)?;
    let root_str = abs_path.to_string_lossy().to_string();
    let service = ProjectFileService::new(state.runtime(), abs_path);
    let file = read_text_resolving(&service, &query.relative_path, &[root_str.as_str()]).await?;

    Ok(Json(WorkspaceFileEnvelope {
        file: WorkspaceFileResponse::from(file),
    }))
}

/// Read a binary file from any absolute workspace root.
async fn read_workspace_binary_file(
    State(state): State<AppState>,
    Query(query): Query<WorkspaceFileQuery>,
) -> Result<Response, ApiError> {
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let abs_path = resolve_workspace_root(&query.abs_path)?;
    let root_str = abs_path.to_string_lossy().to_string();
    let service = ProjectFileService::new(state.runtime(), abs_path);
    let binary_file =
        read_binary_resolving(&service, &query.relative_path, &[root_str.as_str()]).await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, binary_file.mime_type)
        .header(header::CONTENT_LENGTH, binary_file.size)
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(binary_file.data))
        .unwrap())
}

/// Path-based asset endpoint for HTML preview from arbitrary workspace roots.
/// The workspace root absolute path is base64url-encoded as a single path
/// segment so that relative URLs in served HTML resolve to sibling assets.
async fn read_workspace_asset(
    State(state): State<AppState>,
    Path((encoded_root, relative_path)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    if relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest("asset path is required".into()));
    }
    let abs_path_bytes = URL_SAFE_NO_PAD
        .decode(encoded_root.as_bytes())
        .map_err(|_| ApiError::BadRequest("invalid encoded workspace root".into()))?;
    let abs_path_str = String::from_utf8(abs_path_bytes)
        .map_err(|_| ApiError::BadRequest("invalid encoded workspace root".into()))?;
    let abs_path = resolve_workspace_root(&abs_path_str)?;
    let root_str = abs_path.to_string_lossy().to_string();
    let service = ProjectFileService::new(state.runtime(), abs_path);
    let binary_file = read_binary_resolving(&service, &relative_path, &[root_str.as_str()]).await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, binary_file.mime_type)
        .header(header::CONTENT_LENGTH, binary_file.size)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(binary_file.data))
        .unwrap())
}

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/filesystem/directory", get(list_directory))
        .route("/filesystem/cwd", get(current_directory))
        .route("/filesystem/workspace-entries", get(list_workspace_entries))
        .route("/filesystem/workspace-file", get(read_workspace_file))
        .route(
            "/filesystem/workspace-binary-file",
            get(read_workspace_binary_file),
        )
        .route(
            "/filesystem/workspace-asset/:encoded_root/*relative_path",
            get(read_workspace_asset),
        )
}
