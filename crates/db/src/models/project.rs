use std::path::Path;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Sqlite};
use ts_rs::TS;
use uuid::Uuid;

use crate::slug::generate_slug;

/// Project record
///
/// Represents a project with its git repository and associated scripts.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "project-record.ts")]
pub struct ProjectRecord {
    pub id: Uuid,
    pub slug: Option<String>,
    pub name: String,
    pub git_repo_path: String,
    pub setup_script: Option<String>,
    pub dev_script: Option<String>,
    pub cleanup_script: Option<String>,
    pub copy_files: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ProjectRecord {
    /// Create a new project record
    pub fn new(name: impl Into<String>, git_repo_path: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            slug: Some(generate_slug()),
            name: name.into(),
            git_repo_path: git_repo_path.into(),
            setup_script: None,
            dev_script: None,
            cleanup_script: None,
            copy_files: None,
            created_at: now,
            updated_at: now,
        }
    }

    /// Fetch a project by its primary key, returning a row-not-found error if missing.
    pub async fn get(pool: &Pool<Sqlite>, id: Uuid) -> Result<Self, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM project_records WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
    }

    /// Look up a project id by repository path.
    pub async fn find_id_by_git_repo_path(
        pool: &Pool<Sqlite>,
        git_repo_path: &str,
    ) -> Result<Option<Uuid>, sqlx::Error> {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM project_records WHERE git_repo_path = ?")
            .bind(git_repo_path)
            .fetch_optional(pool)
            .await
    }

    /// Fetch a project by repository path if it exists.
    pub async fn find_by_git_repo_path(
        pool: &Pool<Sqlite>,
        git_repo_path: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM project_records WHERE git_repo_path = ?")
            .bind(git_repo_path)
            .fetch_optional(pool)
            .await
    }

    /// Ensure a project exists for the repository path, creating it if necessary.
    pub async fn ensure_with_name_hint(
        pool: &Pool<Sqlite>,
        git_repo_path: &str,
        name_hint: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        if let Some(existing) = Self::find_by_git_repo_path(pool, git_repo_path).await? {
            return Ok(existing);
        }

        let resolved_name = name_hint
            .and_then(|value| {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            })
            .unwrap_or_else(|| Self::infer_name_from_path(git_repo_path));

        let project = ProjectRecord::new(resolved_name, git_repo_path.to_string());
        sqlx::query(
            "INSERT INTO project_records (id, slug, name, git_repo_path, setup_script, dev_script, cleanup_script, copy_files, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)",
        )
        .bind(project.id)
        .bind(&project.slug)
        .bind(&project.name)
        .bind(&project.git_repo_path)
        .bind(project.created_at)
        .bind(project.updated_at)
        .execute(pool)
        .await?;

        Ok(project)
    }

    /// Fetch a project by slug.
    pub async fn find_by_slug(
        pool: &Pool<Sqlite>,
        slug: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM project_records WHERE slug = ?")
            .bind(slug)
            .fetch_optional(pool)
            .await
    }

    /// Return every project, ordered by name ascending.
    ///
    /// Backs the cross-project inbox, which resolves task `project_id`s to
    /// human-friendly project names without requiring each project to be open.
    pub async fn list_all(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>("SELECT * FROM project_records ORDER BY name ASC")
            .fetch_all(pool)
            .await
    }

    /// Fetch a project by either UUID string or slug.
    /// Tries UUID parse first, falls back to slug lookup.
    pub async fn get_by_identifier(
        pool: &Pool<Sqlite>,
        identifier: &str,
    ) -> Result<Self, sqlx::Error> {
        if let Ok(uuid) = Uuid::parse_str(identifier) {
            return Self::get(pool, uuid).await;
        }
        Self::find_by_slug(pool, identifier)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Derive a human-friendly name from a repository path.
    pub fn infer_name_from_path(path: &str) -> String {
        Path::new(path)
            .file_name()
            .and_then(|os| os.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(path)
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_creation() {
        let project = ProjectRecord::new("test-project", "/path/to/repo");
        assert_eq!(project.name, "test-project");
        assert_eq!(project.git_repo_path, "/path/to/repo");
        assert!(project.setup_script.is_none());
    }
}
