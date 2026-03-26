use std::time::SystemTime;

use chrono::{DateTime, Utc};
use filesystem::{
    FilesystemError, FilesystemService, WorkspaceEntry, WorkspaceEntryType, WorkspaceFile,
};
use napi::bindgen_prelude::Result;
use napi_derive::napi;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectEntryResponse {
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
struct ProjectFileResponse {
    relative_path: String,
    content: String,
    size: u64,
    modified_at: Option<String>,
}

fn format_system_time(time: Option<SystemTime>) -> Option<String> {
    time.map(|ts| DateTime::<Utc>::from(ts).to_rfc3339())
}

fn map_error(error: FilesystemError) -> napi::Error {
    let code = match error {
        FilesystemError::WorkspaceMissing => "WorkspaceMissing",
        FilesystemError::InvalidRelativePath => "InvalidRelativePath",
        FilesystemError::OutsideWorkspace => "OutsideWorkspace",
        FilesystemError::NotDirectory => "NotDirectory",
        FilesystemError::NotFile => "NotFile",
        FilesystemError::NotFound => "NotFound",
        FilesystemError::DirectoryDoesNotExist => "DirectoryDoesNotExist",
        FilesystemError::AlreadyExists => "AlreadyExists",
        FilesystemError::Timeout(_) => "Timeout",
        FilesystemError::Io(_) => "Io",
    };
    napi::Error::from_reason(code.to_string())
}

impl From<WorkspaceEntry> for ProjectEntryResponse {
    fn from(entry: WorkspaceEntry) -> Self {
        Self {
            r#type: match entry.entry_type {
                WorkspaceEntryType::Directory => "directory".to_string(),
                WorkspaceEntryType::File => "file".to_string(),
            },
            name: entry.name,
            display_name: entry.display_name,
            relative_path: entry.relative_path,
            extension: entry.extension,
            has_children: entry.has_children,
            size: entry.size,
            modified_at: format_system_time(entry.modified),
            created_at: format_system_time(entry.created),
            children: entry.children.map(|children| {
                children
                    .into_iter()
                    .map(ProjectEntryResponse::from)
                    .collect()
            }),
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

#[napi(js_name = "listWorkspaceEntries")]
pub fn list_workspace_entries(
    workspace_root: String,
    relative_path: Option<String>,
    recursive: Option<bool>,
    include_hidden: Option<bool>,
) -> Result<String> {
    let service = FilesystemService::new();
    let recursive = recursive.unwrap_or(false);
    let include_hidden = include_hidden.unwrap_or(false);

    let entries = if recursive {
        service.list_workspace_entries_recursive(
            &workspace_root,
            relative_path.as_deref(),
            include_hidden,
        )
    } else {
        service.list_workspace_entries(
            &workspace_root,
            relative_path.as_deref(),
            include_hidden,
        )
    }
    .map_err(map_error)?;

    let payload: Vec<ProjectEntryResponse> = entries
        .into_iter()
        .map(ProjectEntryResponse::from)
        .collect();
    serde_json::to_string(&payload)
        .map_err(|error| napi::Error::from_reason(format!("SerializeError:{error}")))
}

#[napi(js_name = "readWorkspaceFile")]
pub fn read_workspace_file(workspace_root: String, relative_path: String) -> Result<String> {
    let service = FilesystemService::new();
    let file = service
        .read_workspace_file(&workspace_root, &relative_path)
        .map_err(map_error)?;
    let payload = ProjectFileResponse::from(file);
    serde_json::to_string(&payload)
        .map_err(|error| napi::Error::from_reason(format!("SerializeError:{error}")))
}
