use std::{
    env, fs,
    path::{Path, PathBuf},
};

use db::models::{AssetImage, CreateAssetImage, TaskImageLink};
use once_cell::sync::Lazy;
use regex::{Captures, Regex};
use sha2::{Digest, Sha256};
use sqlx::{Pool, Sqlite};
use thiserror::Error;
use tracing::{debug, info, warn};
use uuid::Uuid;

const DEFAULT_MAX_IMAGE_SIZE: u64 = 20 * 1024 * 1024;
pub const WORKTREE_IMAGES_DIR: &str = ".chro-context";

/// Ensure the `.chro-context` directory exists under `root` and contains a
/// `.gitignore` with `*` so that all context files stay untracked.
///
/// This is the single authoritative bootstrap for the context directory —
/// callers (image copy, transcript generation, context-file copy) should all
/// delegate here instead of duplicating the logic.
pub fn ensure_context_dir(root: &Path) -> std::io::Result<PathBuf> {
    let dir = root.join(WORKTREE_IMAGES_DIR);
    fs::create_dir_all(&dir)?;
    let gitignore = dir.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, "*\n")?;
    }
    Ok(dir)
}

static WORKTREE_LINK_RE: Lazy<Regex> = Lazy::new(|| {
    let pattern = format!(
        r#"!\[([^\]]*)\]\((?:\./)?({}/[^)\s]+)\)"#,
        regex::escape(WORKTREE_IMAGES_DIR)
    );
    Regex::new(&pattern).expect("valid worktree image regex")
});

#[derive(Debug, Error)]
pub enum ImageError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error("unsupported image format")]
    InvalidFormat,
    #[error("image too large: {size} bytes (max {max})")]
    TooLarge { size: u64, max: u64 },
    #[error("image not found")]
    NotFound,
}

#[derive(Clone)]
pub struct ImageService {
    pool: Pool<Sqlite>,
    cache_dir: PathBuf,
    max_size_bytes: u64,
}

impl ImageService {
    pub fn new(pool: Pool<Sqlite>) -> Result<Self, ImageError> {
        Self::with_cache_dir(pool, default_cache_root())
    }

    pub fn with_cache_dir(pool: Pool<Sqlite>, dir: impl AsRef<Path>) -> Result<Self, ImageError> {
        let cache_dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&cache_dir)?;
        Ok(Self {
            pool,
            cache_dir,
            max_size_bytes: DEFAULT_MAX_IMAGE_SIZE,
        })
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }

    pub fn set_max_size_bytes(&mut self, bytes: u64) {
        self.max_size_bytes = bytes.max(1);
    }

    pub async fn store_image(
        &self,
        data: &[u8],
        original_filename: &str,
    ) -> Result<AssetImage, ImageError> {
        let size = data.len() as u64;
        if size == 0 {
            return Err(ImageError::InvalidFormat);
        }

        if size > self.max_size_bytes {
            return Err(ImageError::TooLarge {
                size,
                max: self.max_size_bytes,
            });
        }

        let hash = format!("{:x}", Sha256::digest(data));
        if let Some(existing) = AssetImage::find_by_hash(&self.pool, &hash).await? {
            debug!(hash = %hash, "reusing cached image");
            return Ok(existing);
        }

        let (extension, mime) = infer_extension_and_mime(original_filename)?;
        let filename = format!("{}.{}", Uuid::new_v4(), extension);
        let cached_path = self.cache_dir.join(&filename);
        fs::write(&cached_path, data)?;

        let size_bytes = i32::try_from(size).unwrap_or(i32::MAX);
        let image = AssetImage::insert(
            &self.pool,
            CreateAssetImage {
                file_path: filename,
                original_name: original_filename.to_string(),
                mime_type: Some(mime.to_string()),
                size_bytes,
                hash,
            },
        )
        .await?;
        debug!(file = %image.file_path, "stored image");
        Ok(image)
    }

    pub async fn store_and_link_task(
        &self,
        data: &[u8],
        original_filename: &str,
        task_id: Uuid,
    ) -> Result<AssetImage, ImageError> {
        let image = self.store_image(data, original_filename).await?;
        self.link_images_to_task(task_id, &[image.id]).await?;
        Ok(image)
    }

    pub async fn link_images_to_task(
        &self,
        task_id: Uuid,
        image_ids: &[Uuid],
    ) -> Result<(), ImageError> {
        TaskImageLink::associate_many_dedup(&self.pool, task_id, image_ids).await?;
        Ok(())
    }

    pub async fn unlink_task_images(&self, task_id: Uuid) -> Result<(), ImageError> {
        TaskImageLink::delete_by_task_id(&self.pool, task_id).await?;
        Ok(())
    }

    pub async fn get_task_images(&self, task_id: Uuid) -> Result<Vec<AssetImage>, ImageError> {
        AssetImage::find_by_task_id(&self.pool, task_id)
            .await
            .map_err(ImageError::from)
    }

    pub async fn get_image(&self, id: Uuid) -> Result<AssetImage, ImageError> {
        AssetImage::find_by_id(&self.pool, id)
            .await?
            .ok_or(ImageError::NotFound)
    }

    pub async fn delete_image(&self, id: Uuid) -> Result<(), ImageError> {
        if let Some(image) = AssetImage::find_by_id(&self.pool, id).await? {
            let cached_path = self.cache_dir.join(&image.file_path);
            if cached_path.exists() {
                fs::remove_file(&cached_path)?;
            }
            AssetImage::delete(&self.pool, id).await?;
            Ok(())
        } else {
            Err(ImageError::NotFound)
        }
    }

    pub async fn delete_orphaned_images(&self) -> Result<u64, ImageError> {
        let orphaned = AssetImage::find_orphaned_images(&self.pool).await?;
        if orphaned.is_empty() {
            return Ok(0);
        }

        let mut deleted = 0u64;
        for image in orphaned {
            let cached_path = self.cache_dir.join(&image.file_path);
            if cached_path.exists() {
                if let Err(err) = fs::remove_file(&cached_path) {
                    warn!(error = %err, file = %cached_path.display(), "failed to remove cached image");
                }
            }
            AssetImage::delete(&self.pool, image.id).await?;
            deleted += 1;
        }

        info!(count = deleted, "removed orphaned images");
        Ok(deleted)
    }

    pub async fn copy_task_images_to_worktree(
        &self,
        worktree_path: &Path,
        task_id: Uuid,
    ) -> Result<(), ImageError> {
        let images = self.get_task_images(task_id).await?;
        self.copy_images(worktree_path, &images)
    }

    pub async fn copy_images_by_ids_to_worktree(
        &self,
        worktree_path: &Path,
        image_ids: &[Uuid],
    ) -> Result<(), ImageError> {
        if image_ids.is_empty() {
            return Ok(());
        }
        let mut images = Vec::with_capacity(image_ids.len());
        for id in image_ids {
            if let Some(image) = AssetImage::find_by_id(&self.pool, *id).await? {
                images.push(image);
            }
        }
        self.copy_images(worktree_path, &images)
    }

    pub fn markdown_path(&self, image: &AssetImage) -> String {
        format!("{}/{}", WORKTREE_IMAGES_DIR, image.file_path)
    }

    /// Extract the file_path from a markdown path (e.g., ".chro-context/uuid.png" -> "uuid.png").
    pub fn extract_file_path(markdown_path: &str) -> Option<&str> {
        let prefix = format!("{}/", WORKTREE_IMAGES_DIR);
        markdown_path.strip_prefix(&prefix)
    }

    /// Look up an image by its markdown path (e.g., ".chro-context/uuid.png").
    pub async fn get_image_by_markdown_path(
        &self,
        markdown_path: &str,
    ) -> Result<AssetImage, ImageError> {
        let file_path = Self::extract_file_path(markdown_path).ok_or(ImageError::NotFound)?;
        AssetImage::find_by_file_path(&self.pool, file_path)
            .await?
            .ok_or(ImageError::NotFound)
    }

    pub fn get_cached_path(&self, image: &AssetImage) -> PathBuf {
        self.cache_dir.join(&image.file_path)
    }

    pub fn canonicalize_worktree_links(prompt: &str, worktree_path: &Path) -> String {
        WORKTREE_LINK_RE
            .replace_all(prompt, |caps: &Captures| {
                let alt = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let relative = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let absolute = worktree_path.join(relative);
                let normalized = absolute.to_string_lossy().replace('\\', "/");
                format!("![{alt}]({normalized})")
            })
            .into_owned()
    }

    fn copy_images(&self, worktree_path: &Path, images: &[AssetImage]) -> Result<(), ImageError> {
        if images.is_empty() {
            return Ok(());
        }

        let images_dir = worktree_path.join(WORKTREE_IMAGES_DIR);

        let all_exist = images
            .iter()
            .all(|image| images_dir.join(&image.file_path).exists());
        if all_exist {
            debug!("all images already exist in worktree, skipping copy");
            return Ok(());
        }

        ensure_context_dir(worktree_path)?;

        for image in images {
            let src = self.cache_dir.join(&image.file_path);
            if !src.exists() {
                warn!(file = %src.display(), "missing cached image");
                continue;
            }
            let dst = images_dir.join(&image.file_path);
            if dst.exists() {
                continue;
            }
            fs::copy(&src, &dst)?;
        }

        Ok(())
    }
}

fn default_cache_root() -> PathBuf {
    if let Some(mut dir) = dirs::cache_dir() {
        dir.push("chro");
        dir
    } else {
        env::temp_dir().join("chro")
    }
}

fn infer_extension_and_mime(filename: &str) -> Result<(String, &'static str), ImageError> {
    let ext = Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_else(|| "png".to_string());

    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return Err(ImageError::InvalidFormat),
    };

    Ok((ext, mime))
}

#[cfg(test)]
mod tests {
    use super::*;
    use db::DBService;

    async fn create_task(pool: &Pool<Sqlite>) -> Uuid {
        let project_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO project_records (id, name, git_repo_path, created_at, updated_at)
             VALUES (?, 'project', '/tmp/repo', datetime('now'), datetime('now'))",
        )
        .bind(project_id)
        .execute(pool)
        .await
        .unwrap();

        let task_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO task_records (id, project_id, title, status, created_at, updated_at)
             VALUES (?, ?, 'task', 'pending', datetime('now'), datetime('now'))",
        )
        .bind(task_id)
        .bind(project_id)
        .execute(pool)
        .await
        .unwrap();

        task_id
    }

    async fn service_with_temp_cache() -> (ImageService, tempfile::TempDir, DBService) {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("test.db");
        let db = DBService::new_with_path(&db_path).await.unwrap();
        let cache_dir = tmp.path().join("cache");
        let service = ImageService::with_cache_dir(db.pool().clone(), &cache_dir).unwrap();
        (service, tmp, db)
    }

    #[tokio::test]
    async fn stores_and_dedupes_images() {
        let (service, _tmp, _db) = service_with_temp_cache().await;
        let bytes = vec![1u8; 16];
        let first = service.store_image(&bytes, "note.png").await.unwrap();
        let second = service.store_image(&bytes, "renamed.png").await.unwrap();
        assert_eq!(first.id, second.id);
    }

    #[tokio::test]
    async fn links_and_copies_images() {
        let (service, tmp, db) = service_with_temp_cache().await;
        let task_id = create_task(db.pool()).await;
        let bytes = vec![2u8; 32];
        let image = service
            .store_and_link_task(&bytes, "screenshot.png", task_id)
            .await
            .unwrap();

        let worktree = tmp.path().join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        service
            .copy_task_images_to_worktree(&worktree, task_id)
            .await
            .unwrap();

        let copied = worktree.join(WORKTREE_IMAGES_DIR).join(&image.file_path);
        assert!(copied.exists());
    }

    #[tokio::test]
    async fn canonicalizes_paths() {
        let worktree = PathBuf::from("/tmp/worktree");
        let input = "![shot](.chro-context/foo.png)";
        let output = ImageService::canonicalize_worktree_links(input, &worktree);
        assert!(output.contains("/tmp/worktree/.chro-context/foo.png"));
    }

    #[test]
    fn extract_file_path() {
        assert_eq!(
            ImageService::extract_file_path(".chro-context/foo.png"),
            Some("foo.png")
        );
    }
}
