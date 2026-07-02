//! Project management endpoints.

use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use db::models::ProjectRecord;
use filesystem::{
    MediaEntry, WorkspaceEntry, WorkspaceEntryDetail, WorkspaceEntryType, WorkspaceFile,
};
use runtime::{ProjectFileService, Runtime, RuntimeError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

use super::path_resolve::{read_binary_resolving, read_text_resolving, require_internal};
use crate::{format_system_time, ApiError, AppState};

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/projects", get(list_projects))
        .route("/projects/ensure", post(ensure_project))
        .route("/projects/general", post(ensure_general_project))
        .route("/projects/:project_id", get(get_project))
        .route("/projects/:project_id/entries", get(list_project_entries))
        .route("/projects/:project_id/media", get(list_project_media))
        .route(
            "/projects/:project_id/file",
            get(read_project_file)
                .put(write_project_file)
                .delete(delete_project_file),
        )
        .route(
            "/projects/:project_id/binary-file",
            get(read_project_binary_file).post(write_project_binary_file),
        )
        .route(
            "/projects/:project_id/asset/*relative_path",
            get(read_project_asset),
        )
        .route(
            "/projects/:project_id/directory",
            post(create_project_directory),
        )
        .route("/projects/:project_id/rename", post(rename_project_entry))
        .route("/projects/:project_id/copy", post(copy_project_entry))
        .route("/projects/:project_id/search", get(search_project_files))
        .route(
            "/projects/:project_id/reveal-in-finder",
            post(reveal_in_finder),
        )
}

#[derive(Debug, Serialize)]
struct ProjectEnvelope {
    project: ProjectRecord,
    /// True when this is the hidden "General" project that backs scratch chats
    /// (keyed on the chats root). The frontend uses it to hide git affordances
    /// and surface the "Choose project" picker for general chats.
    is_general: bool,
}

impl ProjectEnvelope {
    fn new(project: ProjectRecord) -> Self {
        let is_general = project.git_repo_path == config::chats_dir().to_string_lossy();
        Self {
            project,
            is_general,
        }
    }
}

#[derive(Debug, Serialize)]
struct ProjectListItem {
    #[serde(flatten)]
    project: ProjectRecord,
    /// True for the hidden "General" project that backs scratch chats. Lets the
    /// cross-project inbox keep its sessions visible while dropping sessions
    /// from projects the user removed from the sidebar.
    is_general: bool,
}

#[derive(Debug, Serialize)]
struct ProjectsEnvelope {
    projects: Vec<ProjectListItem>,
}

/// List every known project. Used by the cross-project inbox to resolve task
/// `project_id`s to names without each project being open in the sidebar.
async fn list_projects(State(state): State<AppState>) -> Result<Json<ProjectsEnvelope>, ApiError> {
    let chats_dir = config::chats_dir();
    let chats_dir = chats_dir.to_string_lossy();
    let projects = ProjectRecord::list_all(state.pool())
        .await?
        .into_iter()
        .map(|project| {
            let is_general = project.git_repo_path == chats_dir;
            ProjectListItem {
                project,
                is_general,
            }
        })
        .collect();
    Ok(Json(ProjectsEnvelope { projects }))
}

#[derive(Debug, Deserialize)]
struct EnsureProjectRequest {
    name: Option<String>,
    git_repo_path: String,
}

async fn ensure_project(
    State(state): State<AppState>,
    Json(payload): Json<EnsureProjectRequest>,
) -> Result<Json<ProjectEnvelope>, ApiError> {
    let repo_path = payload.git_repo_path.trim();
    let project = ProjectRecord::ensure_with_name_hint(
        state.pool(),
        if repo_path.is_empty() {
            &payload.git_repo_path
        } else {
            repo_path
        },
        payload.name.as_deref(),
    )
    .await?;

    Ok(Json(ProjectEnvelope::new(project)))
}

/// Ensure the single hidden "General" project that backs general-purpose
/// ("scratch") chats, keyed on the persistent chats root. Idempotent: repeated
/// calls return the same project. The frontend calls this to obtain the slug it
/// navigates to when opening a new chat, without ever adding it to the projects
/// tree.
async fn ensure_general_project(
    State(state): State<AppState>,
) -> Result<Json<ProjectEnvelope>, ApiError> {
    let chats_dir = config::chats_dir();
    let chats_dir = chats_dir.to_string_lossy();
    let project =
        ProjectRecord::ensure_with_name_hint(state.pool(), chats_dir.as_ref(), Some("General"))
            .await?;
    Ok(Json(ProjectEnvelope::new(project)))
}

async fn get_project(
    State(state): State<AppState>,
    Path(identifier): Path<String>,
) -> Result<Json<ProjectEnvelope>, ApiError> {
    let project = ProjectRecord::get_by_identifier(state.pool(), &identifier)
        .await
        .map_err(|err| match err {
            sqlx::Error::RowNotFound => ApiError::NotFound,
            other => ApiError::Sqlx(other),
        })?;
    Ok(Json(ProjectEnvelope::new(project)))
}

#[derive(Debug, Deserialize)]
struct ProjectEntriesQuery {
    relative_path: Option<String>,
    /// If true, returns the entire tree structure recursively
    #[serde(default)]
    recursive: bool,
    /// Entry payload detail level: "basic" | "full" (default: "full")
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProjectFileQuery {
    relative_path: String,
}

#[derive(Debug, Serialize)]
pub(super) struct ProjectEntriesEnvelope {
    entries: Vec<ProjectEntryResponse>,
}

impl ProjectEntriesEnvelope {
    /// Build an envelope from raw workspace entries. Shared with the task-run
    /// entries endpoint so both project and worktree listings use one shape.
    pub(super) fn from_entries(entries: Vec<WorkspaceEntry>) -> Self {
        Self {
            entries: entries
                .into_iter()
                .map(ProjectEntryResponse::from)
                .collect(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectEntryResponse {
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
    children: Option<Vec<ProjectEntryResponse>>,
}

#[derive(Debug, Serialize)]
struct ProjectFileEnvelope {
    file: ProjectFileResponse,
}

#[derive(Debug, Serialize)]
struct ProjectFileResponse {
    relative_path: String,
    content: String,
    size: u64,
    modified_at: Option<String>,
}

impl From<WorkspaceEntry> for ProjectEntryResponse {
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
                .map(|c| c.into_iter().map(ProjectEntryResponse::from).collect()),
        }
    }
}

impl From<WorkspaceFile> for ProjectFileResponse {
    fn from(file: WorkspaceFile) -> Self {
        Self {
            relative_path: file.relative_path,
            content: file.content,
            size: file.size,
            modified_at: format_system_time(file.modified),
        }
    }
}

/// Query for the gallery media listing. Shared by the project and task-run
/// media endpoints.
#[derive(Debug, Deserialize)]
pub(super) struct MediaQuery {
    pub(super) limit: Option<usize>,
}

const DEFAULT_MEDIA_LIMIT: usize = 2000;
const MAX_MEDIA_LIMIT: usize = 10_000;

/// Clamp a caller-supplied media `limit` into the supported range, defaulting
/// when absent. Shared so both media endpoints cap identically.
pub(super) fn media_limit(limit: Option<usize>) -> usize {
    limit
        .unwrap_or(DEFAULT_MEDIA_LIMIT)
        .clamp(1, MAX_MEDIA_LIMIT)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaItemResponse {
    relative_path: String,
    kind: String,
    size: Option<u64>,
    modified_at: Option<String>,
}

impl From<MediaEntry> for MediaItemResponse {
    fn from(entry: MediaEntry) -> Self {
        Self {
            relative_path: entry.relative_path,
            kind: entry.kind.as_str().to_string(),
            size: entry.size,
            modified_at: format_system_time(entry.modified),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaEnvelope {
    items: Vec<MediaItemResponse>,
    /// True when more media exist than `limit`, so the gallery can say the view
    /// is capped rather than implying it shows everything.
    truncated: bool,
}

impl MediaEnvelope {
    /// Build an envelope from a media listing. Shared with the task-run media
    /// endpoint so both scopes return one shape.
    pub(super) fn from_media(items: Vec<MediaEntry>, truncated: bool) -> Self {
        Self {
            items: items.into_iter().map(MediaItemResponse::from).collect(),
            truncated,
        }
    }
}

async fn resolve_project_path(
    state: &AppState,
    identifier: &str,
) -> Result<(Uuid, PathBuf), ApiError> {
    let project = ProjectRecord::get_by_identifier(state.pool(), identifier).await?;
    Ok((project.id, PathBuf::from(&project.git_repo_path)))
}

async fn list_project_entries(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ProjectEntriesQuery>,
) -> Result<Json<ProjectEntriesEnvelope>, ApiError> {
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let service = ProjectFileService::new(state.runtime(), project_path);
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
    let entries = if query.recursive {
        service
            .list_entries_recursive(query.relative_path.as_deref(), detail)
            .await?
    } else {
        service
            .list_entries(query.relative_path.as_deref(), detail)
            .await?
    };

    Ok(Json(ProjectEntriesEnvelope::from_entries(entries)))
}

async fn list_project_media(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<MediaQuery>,
) -> Result<Json<MediaEnvelope>, ApiError> {
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let service = ProjectFileService::new(state.runtime(), project_path);
    let (items, truncated) = service.list_media(media_limit(query.limit)).await?;
    Ok(Json(MediaEnvelope::from_media(items, truncated)))
}

async fn read_project_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ProjectFileQuery>,
) -> Result<Json<ProjectFileEnvelope>, ApiError> {
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let project_root = project_path.to_string_lossy().to_string();
    let service = ProjectFileService::new(state.runtime(), project_path);
    let file =
        read_text_resolving(&service, &query.relative_path, &[project_root.as_str()]).await?;

    Ok(Json(ProjectFileEnvelope {
        file: ProjectFileResponse::from(file),
    }))
}

/// Path-based asset endpoint for HTML preview. Unlike `binary-file` (which uses
/// a query parameter), this puts the relative file path directly into the URL
/// so that relative URLs in served HTML (e.g. `<link href="style.css">`)
/// resolve naturally to sibling assets via the same endpoint.
async fn read_project_asset(
    State(state): State<AppState>,
    Path((project_id, relative_path)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    if relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest("asset path is required".into()));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let project_root = project_path.to_string_lossy().to_string();
    let service = ProjectFileService::new(state.runtime(), project_path);
    let binary_file =
        read_binary_resolving(&service, &relative_path, &[project_root.as_str()]).await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, binary_file.mime_type)
        .header(header::CONTENT_LENGTH, binary_file.size)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(binary_file.data))
        .unwrap())
}

async fn read_project_binary_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ProjectFileQuery>,
) -> Result<Response, ApiError> {
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let project_root = project_path.to_string_lossy().to_string();
    let service = ProjectFileService::new(state.runtime(), project_path);
    let binary_file =
        read_binary_resolving(&service, &query.relative_path, &[project_root.as_str()]).await?;

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, binary_file.mime_type)
        .header(header::CONTENT_LENGTH, binary_file.size)
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(binary_file.data))
        .unwrap())
}

#[derive(Debug, Serialize)]
struct WriteBinaryFileResponse {
    relative_path: String,
    size: u64,
    mime_type: String,
}

async fn write_project_binary_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<WriteBinaryFileResponse>, ApiError> {
    let mut relative_path: Option<String> = None;
    let mut file_data: Option<Vec<u8>> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("failed to read multipart field: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "relative_path" => {
                relative_path = Some(
                    field
                        .text()
                        .await
                        .map_err(|e| ApiError::BadRequest(format!("failed to read path: {e}")))?,
                );
            }
            "file" => {
                file_data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| ApiError::BadRequest(format!("failed to read file: {e}")))?
                        .to_vec(),
                );
            }
            _ => {}
        }
    }

    let relative_path = relative_path
        .ok_or_else(|| ApiError::BadRequest("relative_path field is required".into()))?;
    let data = file_data.ok_or_else(|| ApiError::BadRequest("file field is required".into()))?;

    if relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest("relative_path cannot be empty".into()));
    }

    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let binary_file = ProjectFileService::new(state.runtime(), project_path)
        .write_binary_file(&relative_path, data)
        .await?;

    Ok(Json(WriteBinaryFileResponse {
        relative_path: binary_file.relative_path,
        size: binary_file.size,
        mime_type: binary_file.mime_type,
    }))
}

#[derive(Debug, Deserialize)]
struct WriteProjectFileRequest {
    relative_path: String,
    content: String,
}

async fn write_project_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<WriteProjectFileRequest>,
) -> Result<Json<ProjectFileEnvelope>, ApiError> {
    if payload.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest("relative_path is required".into()));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let project_root = project_path.to_string_lossy().to_string();
    let resolved = require_internal(&payload.relative_path, &project_root)?;
    let file = ProjectFileService::new(state.runtime(), project_path)
        .write_file(&resolved, &payload.content)
        .await?;

    Ok(Json(ProjectFileEnvelope {
        file: ProjectFileResponse::from(file),
    }))
}

#[derive(Debug, Serialize)]
struct DeleteProjectFileResponse {
    deleted_path: String,
}

async fn delete_project_file(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ProjectFileQuery>,
) -> Result<Json<DeleteProjectFileResponse>, ApiError> {
    if query.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'relative_path' is required".into(),
        ));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let project_root = project_path.to_string_lossy().to_string();
    let resolved = require_internal(&query.relative_path, &project_root)?;
    let deleted_path = ProjectFileService::new(state.runtime(), project_path)
        .delete_entry(&resolved)
        .await?;

    Ok(Json(DeleteProjectFileResponse { deleted_path }))
}

#[derive(Debug, Deserialize)]
struct CreateDirectoryRequest {
    relative_path: String,
}

#[derive(Debug, Serialize)]
struct CreateDirectoryResponse {
    entry: ProjectEntryResponse,
}

async fn create_project_directory(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<CreateDirectoryRequest>,
) -> Result<Json<CreateDirectoryResponse>, ApiError> {
    if payload.relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest("relative_path is required".into()));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let entry = ProjectFileService::new(state.runtime(), project_path)
        .create_directory(&payload.relative_path)
        .await?;

    Ok(Json(CreateDirectoryResponse {
        entry: ProjectEntryResponse::from(entry),
    }))
}

#[derive(Debug, Deserialize)]
struct RenameEntryRequest {
    old_relative_path: String,
    new_relative_path: String,
}

#[derive(Debug, Serialize)]
struct RenameEntryResponse {
    new_relative_path: String,
}

async fn rename_project_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<RenameEntryRequest>,
) -> Result<Json<RenameEntryResponse>, ApiError> {
    if payload.old_relative_path.trim().is_empty() || payload.new_relative_path.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "old_relative_path and new_relative_path are required".into(),
        ));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let result = ProjectFileService::new(state.runtime(), project_path)
        .rename_entry(&payload.old_relative_path, &payload.new_relative_path)
        .await?;

    Ok(Json(RenameEntryResponse {
        new_relative_path: result,
    }))
}

#[derive(Debug, Deserialize)]
struct CopyEntryRequest {
    source_relative_path: String,
    dest_relative_path: String,
}

#[derive(Debug, Serialize)]
struct CopyEntryResponse {
    entry: ProjectEntryResponse,
}

async fn copy_project_entry(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<CopyEntryRequest>,
) -> Result<Json<CopyEntryResponse>, ApiError> {
    if payload.source_relative_path.trim().is_empty()
        || payload.dest_relative_path.trim().is_empty()
    {
        return Err(ApiError::BadRequest(
            "source_relative_path and dest_relative_path are required".into(),
        ));
    }
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let entry = ProjectFileService::new(state.runtime(), project_path)
        .copy_entry(&payload.source_relative_path, &payload.dest_relative_path)
        .await?;

    Ok(Json(CopyEntryResponse {
        entry: ProjectEntryResponse::from(entry),
    }))
}

#[derive(Debug, Deserialize)]
struct ProjectSearchQuery {
    q: String,
    #[serde(default)]
    mode: Option<String>,
    limit: Option<usize>,
}

#[derive(Debug, Serialize)]
struct ProjectSearchResult {
    path: String,
    is_file: bool,
    match_type: String,
}

#[derive(Debug, Serialize)]
struct ProjectSearchResponse {
    results: Vec<ProjectSearchResult>,
}

async fn search_project_files(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ProjectSearchQuery>,
) -> Result<Json<ProjectSearchResponse>, ApiError> {
    use file_search_cache::{CacheError, SearchMatchType, SearchMode};

    if query.q.trim().is_empty() {
        return Err(ApiError::BadRequest(
            "query parameter 'q' is required".into(),
        ));
    }

    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let limit = query.limit.unwrap_or(10).clamp(1, 100);
    let mode = match query.mode.as_deref() {
        Some("settings") => SearchMode::Settings,
        _ => SearchMode::TaskForm,
    };

    let file_search_cache = state.runtime().file_search_cache();
    let search_results = match file_search_cache
        .search(&project_path, query.q.trim(), mode)
        .await
    {
        Ok(results) => results,
        Err(CacheError::Miss) => {
            file_search_cache.search_fallback(&project_path, query.q.trim(), limit)?
        }
        Err(CacheError::BuildError(e)) => {
            return Err(ApiError::Runtime(RuntimeError::Other(anyhow::anyhow!(
                "Search cache build error: {}",
                e
            ))));
        }
    };

    let results = search_results
        .into_iter()
        .take(limit)
        .map(|r| ProjectSearchResult {
            path: r.path,
            is_file: r.is_file,
            match_type: match r.match_type {
                SearchMatchType::FileName => "FileName".to_string(),
                SearchMatchType::DirectoryName => "DirectoryName".to_string(),
                SearchMatchType::FullPath => "FullPath".to_string(),
                SearchMatchType::ContentMatch => "ContentMatch".to_string(),
            },
        })
        .collect();

    Ok(Json(ProjectSearchResponse { results }))
}

#[derive(Debug, Deserialize)]
struct RevealInFinderRequest {
    relative_path: String,
}

async fn reveal_in_finder(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Json(payload): Json<RevealInFinderRequest>,
) -> Result<StatusCode, ApiError> {
    let (_, project_path) = resolve_project_path(&state, &project_id).await?;
    let full_path = project_path.join(payload.relative_path.trim_start_matches('/'));

    if !full_path.starts_with(&project_path) {
        return Err(ApiError::BadRequest(
            "path is outside project boundary".into(),
        ));
    }

    let fs_service = filesystem::FilesystemService::new();
    tokio::task::spawn_blocking(move || -> Result<(), filesystem::FilesystemError> {
        fs_service.reveal_in_file_manager(&full_path)
    })
    .await
    .map_err(|e| ApiError::BadRequest(format!("spawn failed: {e}")))?
    .map_err(ApiError::Filesystem)?;

    Ok(StatusCode::NO_CONTENT)
}
