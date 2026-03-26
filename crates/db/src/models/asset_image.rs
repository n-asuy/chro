use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Pool, Row, Sqlite};
use ts_rs::TS;
use uuid::Uuid;

/// Asset image (deduplicated by hash)
///
/// Stores image metadata with SHA-256 hash for deduplication.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "asset-image.ts")]
pub struct AssetImage {
    pub id: Uuid,
    pub file_path: String,
    pub original_name: String,
    pub mime_type: Option<String>,
    pub size_bytes: i32,
    pub hash: String, // SHA-256
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Input payload for creating an [`AssetImage`].
#[derive(Debug, Clone)]
pub struct CreateAssetImage {
    pub file_path: String,
    pub original_name: String,
    pub mime_type: Option<String>,
    pub size_bytes: i32,
    pub hash: String,
}

impl AssetImage {
    /// Create a new asset image
    pub fn new(
        file_path: impl Into<String>,
        original_name: impl Into<String>,
        size_bytes: i32,
        hash: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            file_path: file_path.into(),
            original_name: original_name.into(),
            mime_type: None,
            size_bytes,
            hash: hash.into(),
            created_at: now,
            updated_at: now,
        }
    }

    /// Create with MIME type
    pub fn new_with_mime(
        file_path: impl Into<String>,
        original_name: impl Into<String>,
        mime_type: impl Into<String>,
        size_bytes: i32,
        hash: impl Into<String>,
    ) -> Self {
        let mut image = Self::new(file_path, original_name, size_bytes, hash);
        image.mime_type = Some(mime_type.into());
        image
    }

    /// Insert a new image row and return the persisted struct.
    pub async fn insert(pool: &Pool<Sqlite>, data: CreateAssetImage) -> Result<Self, sqlx::Error> {
        let now = Utc::now();
        let id = Uuid::new_v4();
        let CreateAssetImage {
            file_path,
            original_name,
            mime_type,
            size_bytes,
            hash,
        } = data;

        sqlx::query(
            "INSERT INTO asset_images (id, file_path, original_name, mime_type, size_bytes, hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(&file_path)
        .bind(&original_name)
        .bind(&mime_type)
        .bind(size_bytes)
        .bind(&hash)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;

        Ok(Self {
            id,
            file_path,
            original_name,
            mime_type,
            size_bytes,
            hash,
            created_at: now,
            updated_at: now,
        })
    }

    /// Look up an image by its SHA-256 hash.
    pub async fn find_by_hash(
        pool: &Pool<Sqlite>,
        hash: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, AssetImage>(
            "SELECT id, file_path, original_name, mime_type, size_bytes, hash, created_at, updated_at
             FROM asset_images WHERE hash = ?",
        )
        .bind(hash)
        .fetch_optional(pool)
        .await
    }

    /// Look up an image by its identifier.
    pub async fn find_by_id(pool: &Pool<Sqlite>, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, AssetImage>(
            "SELECT id, file_path, original_name, mime_type, size_bytes, hash, created_at, updated_at
             FROM asset_images WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    /// Look up an image by its file path (the path stored in the database, not the markdown path).
    pub async fn find_by_file_path(
        pool: &Pool<Sqlite>,
        file_path: &str,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, AssetImage>(
            "SELECT id, file_path, original_name, mime_type, size_bytes, hash, created_at, updated_at
             FROM asset_images WHERE file_path = ?",
        )
        .bind(file_path)
        .fetch_optional(pool)
        .await
    }

    /// Fetch every image currently linked to a task.
    pub async fn find_by_task_id(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, AssetImage>(
            "SELECT ai.id, ai.file_path, ai.original_name, ai.mime_type, ai.size_bytes, ai.hash, ai.created_at, ai.updated_at
             FROM asset_images ai
             JOIN task_image_links til ON ai.id = til.image_id
             WHERE til.task_id = ?
             ORDER BY til.created_at",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await
    }

    /// Delete an image from the database.
    pub async fn delete(pool: &Pool<Sqlite>, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM asset_images WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    /// List images that do not have any associated task.
    pub async fn find_orphaned_images(pool: &Pool<Sqlite>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, AssetImage>(
            "SELECT ai.id, ai.file_path, ai.original_name, ai.mime_type, ai.size_bytes, ai.hash, ai.created_at, ai.updated_at
             FROM asset_images ai
             LEFT JOIN task_image_links til ON ai.id = til.image_id
             WHERE til.image_id IS NULL",
        )
        .fetch_all(pool)
        .await
    }
}

/// Task image link (many-to-many relationship)
///
/// Links tasks to images, preventing duplicate attachments via UNIQUE constraint.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow, TS)]
#[ts(export, export_to = "task-image-link.ts")]
pub struct TaskImageLink {
    pub id: Uuid,
    pub task_id: Uuid,
    pub image_id: Uuid,
    pub created_at: DateTime<Utc>,
}

impl TaskImageLink {
    /// Create a new task-image link
    pub fn new(task_id: Uuid, image_id: Uuid) -> Self {
        Self {
            id: Uuid::new_v4(),
            task_id,
            image_id,
            created_at: Utc::now(),
        }
    }

    /// Persist a single task→image association.
    pub async fn create(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        image_id: Uuid,
    ) -> Result<Self, sqlx::Error> {
        let now = Utc::now();
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_image_links (id, task_id, image_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(id)
        .bind(task_id)
        .bind(image_id)
        .bind(now)
        .execute(pool)
        .await?;

        Ok(Self {
            id,
            task_id,
            image_id,
            created_at: now,
        })
    }

    /// Associate multiple images with a task while skipping duplicates.
    pub async fn associate_many_dedup(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
        image_ids: &[Uuid],
    ) -> Result<(), sqlx::Error> {
        for image_id in image_ids {
            sqlx::query(
                "INSERT OR IGNORE INTO task_image_links (id, task_id, image_id, created_at)
                 VALUES (?, ?, ?, datetime('now','subsec'))",
            )
            .bind(Uuid::new_v4())
            .bind(task_id)
            .bind(image_id)
            .execute(pool)
            .await?;
        }
        Ok(())
    }

    /// Fetch image ids linked to a task ordered by `created_at`.
    pub async fn list_image_ids(
        pool: &Pool<Sqlite>,
        task_id: Uuid,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT image_id FROM task_image_links WHERE task_id = ? ORDER BY created_at",
        )
        .bind(task_id)
        .fetch_all(pool)
        .await?;

        Ok(rows
            .into_iter()
            .filter_map(|row| row.try_get::<Uuid, _>(0).ok())
            .collect())
    }

    /// Remove all image associations for a task.
    pub async fn delete_by_task_id(pool: &Pool<Sqlite>, task_id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM task_image_links WHERE task_id = ?")
            .bind(task_id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DBService;

    #[test]
    fn test_image_creation() {
        let image = AssetImage::new(
            "/path/to/image.png",
            "screenshot.png",
            12345,
            "abc123def456",
        );
        assert_eq!(image.original_name, "screenshot.png");
        assert_eq!(image.size_bytes, 12345);
        assert_eq!(image.hash, "abc123def456");
    }

    #[test]
    fn test_image_with_mime() {
        let image = AssetImage::new_with_mime(
            "/path/to/image.png",
            "screenshot.png",
            "image/png",
            12345,
            "abc123",
        );
        assert_eq!(image.mime_type, Some("image/png".to_string()));
    }

    #[test]
    fn test_image_link() {
        let task_id = Uuid::new_v4();
        let image_id = Uuid::new_v4();
        let link = TaskImageLink::new(task_id, image_id);
        assert_eq!(link.task_id, task_id);
        assert_eq!(link.image_id, image_id);
    }

    #[tokio::test]
    async fn insert_and_lookup_image() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("insert.db");
        let service = DBService::new_with_path(&db_path).await.unwrap();

        let stored = AssetImage::insert(
            service.pool(),
            CreateAssetImage {
                file_path: "cached.png".into(),
                original_name: "cached.png".into(),
                mime_type: Some("image/png".into()),
                size_bytes: 42,
                hash: "hash-123".into(),
            },
        )
        .await
        .unwrap();

        let by_hash = AssetImage::find_by_hash(service.pool(), "hash-123")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.id, by_hash.id);

        let by_id = AssetImage::find_by_id(service.pool(), stored.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_id.original_name, "cached.png");
    }

    #[tokio::test]
    async fn link_management_and_orphans() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("links.db");
        let service = DBService::new_with_path(&db_path).await.unwrap();

        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'proj', '/tmp/repo', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_records (id, project_id, title, status, created_at, updated_at)
             VALUES (?, ?, 'task', 'pending', datetime('now'), datetime('now'))",
        )
        .bind(task_id)
        .bind(project_id)
        .execute(service.pool())
        .await
        .unwrap();

        let first = AssetImage::insert(
            service.pool(),
            CreateAssetImage {
                file_path: "one.png".into(),
                original_name: "one.png".into(),
                mime_type: Some("image/png".into()),
                size_bytes: 10,
                hash: "hash-one".into(),
            },
        )
        .await
        .unwrap();

        let second = AssetImage::insert(
            service.pool(),
            CreateAssetImage {
                file_path: "two.png".into(),
                original_name: "two.png".into(),
                mime_type: Some("image/png".into()),
                size_bytes: 20,
                hash: "hash-two".into(),
            },
        )
        .await
        .unwrap();

        TaskImageLink::associate_many_dedup(
            service.pool(),
            task_id,
            &[first.id, second.id, first.id],
        )
        .await
        .unwrap();

        let linked = AssetImage::find_by_task_id(service.pool(), task_id)
            .await
            .unwrap();
        assert_eq!(linked.len(), 2);

        let ids = TaskImageLink::list_image_ids(service.pool(), task_id)
            .await
            .unwrap();
        assert_eq!(ids.len(), 2);

        TaskImageLink::delete_by_task_id(service.pool(), task_id)
            .await
            .unwrap();

        let orphans = AssetImage::find_orphaned_images(service.pool())
            .await
            .unwrap();
        assert_eq!(orphans.len(), 2);
    }
}
