use std::path::PathBuf;

use anyhow::anyhow;
use filesystem::{
    FilesystemError, MediaEntry, WorkspaceBinaryFile, WorkspaceEntry, WorkspaceEntryDetail,
    WorkspaceFile,
};
use tokio::{fs, task::spawn_blocking};

use crate::{Runtime, RuntimeError};

pub async fn canonicalize_path(path: &str) -> Result<PathBuf, RuntimeError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(RuntimeError::BadRequest("path must not be empty"));
    }

    let path_buf = PathBuf::from(trimmed);
    let metadata = fs::metadata(&path_buf)
        .await
        .map_err(|_| RuntimeError::BadRequest("path does not exist"))?;

    if !metadata.is_dir() {
        return Err(RuntimeError::BadRequest("path must be a directory"));
    }

    Ok(fs::canonicalize(&path_buf).await.unwrap_or(path_buf))
}

/// Service for file operations within a project directory.
/// The project path is provided explicitly rather than from config.
pub struct ProjectFileService<'a, R: Runtime> {
    runtime: &'a R,
    project_path: PathBuf,
}

impl<'a, R: Runtime> ProjectFileService<'a, R> {
    pub fn new(runtime: &'a R, project_path: PathBuf) -> Self {
        Self {
            runtime,
            project_path,
        }
    }

    fn project_root(&self) -> &PathBuf {
        &self.project_path
    }

    async fn run_blocking<T, F>(&self, job: F) -> Result<T, RuntimeError>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, FilesystemError> + Send + 'static,
    {
        spawn_blocking(job)
            .await
            .map_err(|err| RuntimeError::Other(anyhow!(err)))?
            .map_err(RuntimeError::from)
    }

    pub async fn list_entries(
        &self,
        relative_path: Option<&str>,
        detail: WorkspaceEntryDetail,
    ) -> Result<Vec<WorkspaceEntry>, RuntimeError> {
        let project_path = self.project_root().clone();
        let include_hidden = self.runtime.config().read().await.show_hidden_entries;
        let relative = relative_path.map(|value| value.to_string());
        let fs_service = self.runtime.filesystem().clone();
        self.run_blocking(move || {
            fs_service.list_workspace_entries_with_detail(
                &project_path,
                relative.as_deref(),
                include_hidden,
                detail,
            )
        })
        .await
    }

    /// List entries recursively, returning the entire tree structure in one call.
    pub async fn list_entries_recursive(
        &self,
        relative_path: Option<&str>,
        detail: WorkspaceEntryDetail,
    ) -> Result<Vec<WorkspaceEntry>, RuntimeError> {
        let project_path = self.project_root().clone();
        let include_hidden = self.runtime.config().read().await.show_hidden_entries;
        let relative = relative_path.map(|value| value.to_string());
        let fs_service = self.runtime.filesystem().clone();
        self.run_blocking(move || {
            fs_service.list_workspace_entries_recursive_with_detail(
                &project_path,
                relative.as_deref(),
                include_hidden,
                detail,
            )
        })
        .await
    }

    /// List renderable media (images, video) under the project root for the
    /// gallery, gitignore-aware and newest-first. The boolean reports whether
    /// the result was capped at `limit`.
    pub async fn list_media(&self, limit: usize) -> Result<(Vec<MediaEntry>, bool), RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        self.run_blocking(move || fs_service.list_workspace_media(&project_path, limit))
            .await
    }

    pub async fn read_file(&self, relative_path: &str) -> Result<WorkspaceFile, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let relative = relative_path.to_string();
        self.run_blocking(move || fs_service.read_workspace_file(&project_path, &relative))
            .await
    }

    pub async fn read_binary_file(
        &self,
        relative_path: &str,
    ) -> Result<WorkspaceBinaryFile, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let relative = relative_path.to_string();
        self.run_blocking(move || fs_service.read_workspace_binary_file(&project_path, &relative))
            .await
    }

    /// Read a text file at an arbitrary absolute path outside the workspace.
    ///
    /// Used by read endpoints to serve files an agent referenced by absolute
    /// path (e.g. `/tmp/...`). The caller resolves containment beforehand.
    pub async fn read_file_absolute(&self, path: PathBuf) -> Result<WorkspaceFile, RuntimeError> {
        let fs_service = self.runtime.filesystem().clone();
        self.run_blocking(move || fs_service.read_absolute_file(&path))
            .await
    }

    /// Read a binary file at an arbitrary absolute path outside the workspace.
    /// The binary counterpart to [`read_file_absolute`].
    pub async fn read_binary_file_absolute(
        &self,
        path: PathBuf,
    ) -> Result<WorkspaceBinaryFile, RuntimeError> {
        let fs_service = self.runtime.filesystem().clone();
        self.run_blocking(move || fs_service.read_absolute_binary_file(&path))
            .await
    }

    pub async fn write_file(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceFile, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let relative = relative_path.to_string();
        let body = content.to_string();
        self.run_blocking(move || fs_service.write_workspace_file(&project_path, &relative, &body))
            .await
    }

    pub async fn write_binary_file(
        &self,
        relative_path: &str,
        data: Vec<u8>,
    ) -> Result<WorkspaceBinaryFile, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let relative = relative_path.to_string();
        self.run_blocking(move || {
            fs_service.write_workspace_binary_file(&project_path, &relative, &data)
        })
        .await
    }

    pub async fn delete_entry(&self, relative_path: &str) -> Result<String, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let relative = relative_path.to_string();
        self.run_blocking(move || fs_service.delete_workspace_file(&project_path, &relative))
            .await
    }

    pub async fn create_directory(
        &self,
        relative_path: &str,
    ) -> Result<WorkspaceEntry, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let relative = relative_path.to_string();
        self.run_blocking(move || fs_service.create_workspace_directory(&project_path, &relative))
            .await
    }

    pub async fn rename_entry(
        &self,
        old_relative_path: &str,
        new_relative_path: &str,
    ) -> Result<String, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let old_path = old_relative_path.to_string();
        let new_path = new_relative_path.to_string();
        self.run_blocking(move || {
            fs_service.rename_workspace_entry(&project_path, &old_path, &new_path)
        })
        .await
    }

    pub async fn copy_entry(
        &self,
        source_relative_path: &str,
        dest_relative_path: &str,
    ) -> Result<WorkspaceEntry, RuntimeError> {
        let project_path = self.project_root().clone();
        let fs_service = self.runtime.filesystem().clone();
        let source_path = source_relative_path.to_string();
        let dest_path = dest_relative_path.to_string();
        self.run_blocking(move || {
            fs_service.copy_workspace_entry(&project_path, &source_path, &dest_path)
        })
        .await
    }
}
