use std::{
    cmp::Ordering,
    ffi::OsStr,
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

use ignore::WalkBuilder;

use crate::{FilesystemError, FilesystemService};

/// Text files larger than this are never loaded into memory in full by the
/// workspace APIs. The desktop editor is designed for review rather than for
/// editing generated artifacts that can be hundreds of megabytes.
pub const MAX_INLINE_TEXT_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Keep a useful, bounded preview for oversized text files.
pub const LARGE_TEXT_FILE_PREVIEW_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceEntryType {
    File,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceEntryDetail {
    /// Lightweight listing for fast tree hydration:
    /// skips file metadata and defers child-presence checks.
    Basic,
    /// Full listing with metadata and has-children probes.
    Full,
}

#[derive(Debug, Clone)]
pub struct WorkspaceEntry {
    pub entry_type: WorkspaceEntryType,
    /// The actual file name (e.g., "note.md")
    pub name: String,
    /// The display name without .md extension for markdown files (e.g., "note")
    pub display_name: String,
    pub relative_path: String,
    pub extension: Option<String>,
    pub has_children: Option<bool>,
    pub size: Option<u64>,
    pub modified: Option<SystemTime>,
    pub created: Option<SystemTime>,
    /// Children entries when using recursive listing
    pub children: Option<Vec<WorkspaceEntry>>,
}

/// A renderable media artifact (image or video) found under a workspace root.
/// The byte payload is served separately via the existing binary-file endpoint;
/// this record carries only what the gallery grid needs to lay out and sort.
#[derive(Debug, Clone)]
pub struct MediaEntry {
    pub relative_path: String,
    pub kind: MediaKind,
    pub size: Option<u64>,
    pub modified: Option<SystemTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
        }
    }
}

/// Extensions the gallery treats as still images. Kept as the single source of
/// truth on the Rust side; the frontend mirror lives in `files/media-types.ts`.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "ico", "tiff", "tif",
];

/// Extensions the gallery treats as playable video.
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "mov", "avi", "mkv", "m4v"];

/// Classify a file extension into a [`MediaKind`], or `None` when it is not a
/// media artifact the gallery renders.
pub fn classify_media(extension: Option<&str>) -> Option<MediaKind> {
    let ext = extension?.to_ascii_lowercase();
    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Image)
    } else if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// Get display name (without .md extension for markdown files)
fn get_display_name(name: &str, entry_type: WorkspaceEntryType) -> String {
    if entry_type == WorkspaceEntryType::File {
        if let Some(stripped) = name.strip_suffix(".md") {
            return stripped.to_string();
        }
    }
    name.to_string()
}

#[derive(Debug, Clone)]
pub struct WorkspaceFile {
    pub relative_path: String,
    pub content: String,
    pub size: u64,
    pub modified: Option<SystemTime>,
    /// True when `content` is only a bounded prefix of the file.
    pub truncated: bool,
}

#[derive(Debug, Clone)]
pub struct WorkspaceBinaryFile {
    pub relative_path: String,
    /// Validated path to stream from. Keeping binary payloads out of this
    /// value prevents large videos/PDFs from being copied into the server heap.
    pub path: PathBuf,
    pub size: u64,
    pub mime_type: String,
    pub modified: Option<SystemTime>,
}

impl FilesystemService {
    pub fn list_workspace_entries(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: Option<&str>,
        include_hidden: bool,
    ) -> Result<Vec<WorkspaceEntry>, FilesystemError> {
        self.list_workspace_entries_with_detail(
            workspace_root,
            relative_path,
            include_hidden,
            WorkspaceEntryDetail::Full,
        )
    }

    pub fn list_workspace_entries_with_detail(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: Option<&str>,
        include_hidden: bool,
        detail: WorkspaceEntryDetail,
    ) -> Result<Vec<WorkspaceEntry>, FilesystemError> {
        self.list_workspace_entries_internal(
            workspace_root,
            relative_path,
            include_hidden,
            false,
            detail,
        )
    }

    /// List workspace entries with optional recursive traversal.
    /// When `recursive` is true, directories will include their children inline,
    /// allowing the entire tree to be fetched in a single call.
    pub fn list_workspace_entries_recursive(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: Option<&str>,
        include_hidden: bool,
    ) -> Result<Vec<WorkspaceEntry>, FilesystemError> {
        self.list_workspace_entries_recursive_with_detail(
            workspace_root,
            relative_path,
            include_hidden,
            WorkspaceEntryDetail::Full,
        )
    }

    pub fn list_workspace_entries_recursive_with_detail(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: Option<&str>,
        include_hidden: bool,
        detail: WorkspaceEntryDetail,
    ) -> Result<Vec<WorkspaceEntry>, FilesystemError> {
        self.list_workspace_entries_internal(
            workspace_root,
            relative_path,
            include_hidden,
            true,
            detail,
        )
    }

    /// Walk the workspace for renderable media (images, video) honoring
    /// `.gitignore` and skipping heavy build directories, returning the newest
    /// first. The boolean is `true` when more than `limit` media files exist and
    /// the result was capped, so callers can surface that rather than implying
    /// full coverage. Mirrors the gitignore-aware traversal used by file search.
    pub fn list_workspace_media(
        &self,
        workspace_root: impl AsRef<Path>,
        limit: usize,
    ) -> Result<(Vec<MediaEntry>, bool), FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;

        let mut items: Vec<MediaEntry> = WalkBuilder::new(root)
            .standard_filters(true)
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                name != ".git"
                    && name != "node_modules"
                    && name != "target"
                    && name != "dist"
                    && name != "build"
            })
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_some_and(|ft| ft.is_file()))
            .filter_map(|entry| {
                let path = entry.path();
                let kind = classify_media(path.extension().and_then(OsStr::to_str))?;
                let relative = path.strip_prefix(root).ok()?;
                let relative_path = relative_path_string(relative);
                if relative_path.is_empty() {
                    return None;
                }
                let metadata = entry.metadata().ok();
                Some(MediaEntry {
                    relative_path,
                    kind,
                    size: metadata.as_ref().map(std::fs::Metadata::len),
                    modified: metadata.as_ref().and_then(|m| m.modified().ok()),
                })
            })
            .collect();

        // Newest first; entries without a modified time sort to the end so a
        // missing timestamp never masquerades as the most recent creative.
        items.sort_by(|a, b| match (a.modified, b.modified) {
            (Some(x), Some(y)) => y.cmp(&x),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        });

        let truncated = items.len() > limit;
        items.truncate(limit);
        Ok((items, truncated))
    }

    fn list_workspace_entries_internal(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: Option<&str>,
        include_hidden: bool,
        recursive: bool,
        detail: WorkspaceEntryDetail,
    ) -> Result<Vec<WorkspaceEntry>, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;
        let normalized_relative = normalize_relative_path(relative_path)?;
        let target = if normalized_relative.as_os_str().is_empty() {
            root.to_path_buf()
        } else {
            root.join(&normalized_relative)
        };
        if !target.is_dir() {
            return Err(FilesystemError::NotDirectory);
        }

        let base_relative = relative_path_string(&normalized_relative);
        let mut entries = Vec::new();
        for entry in fs::read_dir(&target)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name_os = entry.file_name();
            let name = name_os.to_string_lossy().to_string();
            let entry_path = entry.path();
            let is_dir = file_type.is_dir() || (file_type.is_symlink() && entry_path.is_dir());
            let is_file = file_type.is_file() || (file_type.is_symlink() && entry_path.is_file());

            if is_dir {
                if !include_hidden && is_hidden(&name) {
                    continue;
                }
                let absolute_child = entry_path;
                let rel = join_relative_string(&base_relative, &name);
                let metadata = match detail {
                    WorkspaceEntryDetail::Basic => None,
                    WorkspaceEntryDetail::Full => entry.metadata().ok(),
                };
                let display_name = get_display_name(&name, WorkspaceEntryType::Directory);

                let children = if recursive {
                    Some(self.list_workspace_entries_internal(
                        root,
                        Some(&rel),
                        include_hidden,
                        true,
                        detail,
                    )?)
                } else {
                    None
                };

                let has_children = if recursive {
                    Some(children.as_ref().is_some_and(|c| !c.is_empty()))
                } else {
                    match detail {
                        WorkspaceEntryDetail::Basic => None,
                        WorkspaceEntryDetail::Full => Some(directory_has_visible_entries(
                            &absolute_child,
                            include_hidden,
                        )?),
                    }
                };

                entries.push(WorkspaceEntry {
                    entry_type: WorkspaceEntryType::Directory,
                    name,
                    display_name,
                    relative_path: rel,
                    extension: None,
                    has_children,
                    size: None,
                    modified: metadata.as_ref().and_then(|m| m.modified().ok()),
                    created: metadata.and_then(|m| m.created().ok()),
                    children,
                });
            } else if is_file {
                let rel = join_relative_string(&base_relative, &name);
                let metadata = match detail {
                    WorkspaceEntryDetail::Basic => None,
                    WorkspaceEntryDetail::Full => entry.metadata().ok(),
                };
                let display_name = get_display_name(&name, WorkspaceEntryType::File);
                entries.push(WorkspaceEntry {
                    entry_type: WorkspaceEntryType::File,
                    name,
                    display_name,
                    relative_path: rel,
                    extension: extract_extension(name_os.as_ref()),
                    has_children: None,
                    size: metadata.as_ref().map(|m| m.len()),
                    modified: metadata.as_ref().and_then(|m| m.modified().ok()),
                    created: metadata.and_then(|m| m.created().ok()),
                    children: None,
                });
            }
        }

        entries.sort_by(compare_entries);
        Ok(entries)
    }

    pub fn read_workspace_file(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: &str,
    ) -> Result<WorkspaceFile, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;
        let normalized_relative = normalize_relative_path(Some(relative_path))?;
        if normalized_relative.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }
        let target = resolve_within_root(root, &normalized_relative)?;
        if !target.is_file() {
            return Err(FilesystemError::NotFile);
        }

        let metadata = fs::metadata(&target)?;
        let (content, truncated) = read_text_file_bounded(&target, metadata.len())?;
        Ok(WorkspaceFile {
            relative_path: relative_path_string(&normalized_relative),
            content,
            size: metadata.len(),
            modified: metadata.modified().ok(),
            truncated,
        })
    }

    /// Read a binary file from the workspace (for images, etc.)
    pub fn read_workspace_binary_file(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: &str,
    ) -> Result<WorkspaceBinaryFile, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;
        let normalized_relative = normalize_relative_path(Some(relative_path))?;
        if normalized_relative.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }
        let target = resolve_within_root(root, &normalized_relative)?;
        if !target.is_file() {
            return Err(FilesystemError::NotFile);
        }

        let metadata = fs::metadata(&target)?;
        let mime_type = infer_mime_type(&target);

        Ok(WorkspaceBinaryFile {
            relative_path: relative_path_string(&normalized_relative),
            path: target,
            size: metadata.len(),
            mime_type,
            modified: metadata.modified().ok(),
        })
    }

    /// Read a text file located at an arbitrary absolute path, outside any
    /// workspace root.
    ///
    /// Used to serve files an agent referenced by absolute path (e.g. output
    /// written to `/tmp`). Callers are responsible for having established that
    /// the path is genuinely external (see `resolve_workspace_path`); no
    /// workspace containment is enforced here.
    pub fn read_absolute_file(&self, path: &Path) -> Result<WorkspaceFile, FilesystemError> {
        if !path.is_file() {
            return Err(FilesystemError::NotFile);
        }
        let metadata = fs::metadata(path)?;
        let (content, truncated) = read_text_file_bounded(path, metadata.len())?;
        Ok(WorkspaceFile {
            relative_path: path.to_string_lossy().to_string(),
            content,
            size: metadata.len(),
            modified: metadata.modified().ok(),
            truncated,
        })
    }

    /// Read a binary file located at an arbitrary absolute path, outside any
    /// workspace root. The binary counterpart to [`read_absolute_file`].
    pub fn read_absolute_binary_file(
        &self,
        path: &Path,
    ) -> Result<WorkspaceBinaryFile, FilesystemError> {
        if !path.is_file() {
            return Err(FilesystemError::NotFile);
        }
        let metadata = fs::metadata(path)?;
        let mime_type = infer_mime_type(path);
        Ok(WorkspaceBinaryFile {
            relative_path: path.to_string_lossy().to_string(),
            path: path.to_path_buf(),
            size: metadata.len(),
            mime_type,
            modified: metadata.modified().ok(),
        })
    }

    /// Write content to a file within the workspace.
    ///
    /// Creates parent directories if needed. Returns metadata about the written file.
    pub fn write_workspace_file(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: &str,
        content: &str,
    ) -> Result<WorkspaceFile, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;
        let normalized_relative = normalize_relative_path(Some(relative_path))?;
        if normalized_relative.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }
        let target = resolve_within_root(root, &normalized_relative)?;

        if let Some(parent) = target.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        fs::write(&target, content)?;

        let metadata = fs::metadata(&target)?;
        Ok(WorkspaceFile {
            relative_path: relative_path_string(&normalized_relative),
            content: content.to_string(),
            size: metadata.len(),
            modified: metadata.modified().ok(),
            truncated: false,
        })
    }

    /// Write binary content to a file within the workspace.
    ///
    /// Creates parent directories if needed. Returns metadata about the written file.
    pub fn write_workspace_binary_file(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: &str,
        data: &[u8],
    ) -> Result<WorkspaceBinaryFile, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;
        let normalized_relative = normalize_relative_path(Some(relative_path))?;
        if normalized_relative.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }
        let target = resolve_within_root(root, &normalized_relative)?;

        if let Some(parent) = target.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        fs::write(&target, data)?;

        let metadata = fs::metadata(&target)?;
        let mime_type = infer_mime_type(&target);

        Ok(WorkspaceBinaryFile {
            relative_path: relative_path_string(&normalized_relative),
            path: target,
            size: metadata.len(),
            mime_type,
            modified: metadata.modified().ok(),
        })
    }

    /// Delete a file within the workspace.
    ///
    /// Returns the relative path of the deleted file on success.
    pub fn delete_workspace_file(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: &str,
    ) -> Result<String, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;
        let normalized_relative = normalize_relative_path(Some(relative_path))?;
        if normalized_relative.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }
        let target = resolve_within_root(root, &normalized_relative)?;
        if !target.exists() {
            return Err(FilesystemError::NotFound);
        }

        if target.is_dir() {
            fs::remove_dir_all(&target)?;
        } else {
            fs::remove_file(&target)?;
        }

        Ok(relative_path_string(&normalized_relative))
    }

    /// Create a directory within the workspace.
    ///
    /// Creates parent directories if needed. Returns metadata about the created directory.
    pub fn create_workspace_directory(
        &self,
        workspace_root: impl AsRef<Path>,
        relative_path: &str,
    ) -> Result<WorkspaceEntry, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;
        let normalized_relative = normalize_relative_path(Some(relative_path))?;
        if normalized_relative.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }
        let target = resolve_within_root(root, &normalized_relative)?;

        fs::create_dir_all(&target)?;

        let name = normalized_relative
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let display_name = get_display_name(&name, WorkspaceEntryType::Directory);
        let metadata = fs::metadata(&target).ok();
        Ok(WorkspaceEntry {
            entry_type: WorkspaceEntryType::Directory,
            name,
            display_name,
            relative_path: relative_path_string(&normalized_relative),
            extension: None,
            has_children: Some(false),
            size: None,
            modified: metadata.as_ref().and_then(|m| m.modified().ok()),
            created: metadata.and_then(|m| m.created().ok()),
            children: None,
        })
    }

    /// Rename a file or directory within the workspace.
    ///
    /// Returns the new relative path on success.
    pub fn rename_workspace_entry(
        &self,
        workspace_root: impl AsRef<Path>,
        old_relative_path: &str,
        new_relative_path: &str,
    ) -> Result<String, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;

        let old_normalized = normalize_relative_path(Some(old_relative_path))?;
        let new_normalized = normalize_relative_path(Some(new_relative_path))?;

        if old_normalized.as_os_str().is_empty() || new_normalized.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }

        let old_target = resolve_within_root(root, &old_normalized)?;
        let new_target = resolve_within_root(root, &new_normalized)?;

        if !old_target.exists() {
            return Err(FilesystemError::NotFound);
        }

        if let Some(parent) = new_target.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        fs::rename(&old_target, &new_target)?;

        Ok(relative_path_string(&new_normalized))
    }

    /// Copy a file or directory within the workspace.
    ///
    /// Returns metadata about the copied entry.
    pub fn copy_workspace_entry(
        &self,
        workspace_root: impl AsRef<Path>,
        source_relative_path: &str,
        dest_relative_path: &str,
    ) -> Result<WorkspaceEntry, FilesystemError> {
        let root = workspace_root.as_ref();
        ensure_workspace_dir(root)?;

        let source_normalized = normalize_relative_path(Some(source_relative_path))?;
        let dest_normalized = normalize_relative_path(Some(dest_relative_path))?;

        if source_normalized.as_os_str().is_empty() || dest_normalized.as_os_str().is_empty() {
            return Err(FilesystemError::InvalidRelativePath);
        }

        let source_target = resolve_within_root(root, &source_normalized)?;
        let dest_target = resolve_within_root(root, &dest_normalized)?;

        if !source_target.exists() {
            return Err(FilesystemError::NotFound);
        }

        if dest_target.exists() {
            return Err(FilesystemError::AlreadyExists);
        }

        if let Some(parent) = dest_target.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)?;
            }
        }

        if source_target.is_dir() {
            copy_dir_recursive(&source_target, &dest_target)?;
            let name = dest_normalized
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let display_name = get_display_name(&name, WorkspaceEntryType::Directory);
            let metadata = fs::metadata(&dest_target).ok();
            let has_children = directory_has_visible_entries(&dest_target, true)?;
            Ok(WorkspaceEntry {
                entry_type: WorkspaceEntryType::Directory,
                name,
                display_name,
                relative_path: relative_path_string(&dest_normalized),
                extension: None,
                has_children: Some(has_children),
                size: None,
                modified: metadata.as_ref().and_then(|m| m.modified().ok()),
                created: metadata.and_then(|m| m.created().ok()),
                children: None,
            })
        } else {
            fs::copy(&source_target, &dest_target)?;
            let name = dest_normalized
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let display_name = get_display_name(&name, WorkspaceEntryType::File);
            let extension = extract_extension(OsStr::new(&name));
            let metadata = fs::metadata(&dest_target).ok();
            Ok(WorkspaceEntry {
                entry_type: WorkspaceEntryType::File,
                name,
                display_name,
                relative_path: relative_path_string(&dest_normalized),
                extension,
                has_children: None,
                size: metadata.as_ref().map(|m| m.len()),
                modified: metadata.as_ref().and_then(|m| m.modified().ok()),
                created: metadata.and_then(|m| m.created().ok()),
                children: None,
            })
        }
    }
}

fn read_text_file_bounded(path: &Path, size: u64) -> Result<(String, bool), io::Error> {
    let file = fs::File::open(path)?;
    let read_limit = if size > MAX_INLINE_TEXT_FILE_BYTES {
        LARGE_TEXT_FILE_PREVIEW_BYTES
    } else {
        // The extra byte catches a file that grows beyond the cap after the
        // metadata lookup, without ever allowing an unbounded read.
        MAX_INLINE_TEXT_FILE_BYTES + 1
    };
    let initial_capacity = size.saturating_add(1).min(read_limit) as usize;
    let mut bytes = Vec::with_capacity(initial_capacity);
    file.take(read_limit).read_to_end(&mut bytes)?;
    let truncated =
        size > MAX_INLINE_TEXT_FILE_BYTES || bytes.len() > MAX_INLINE_TEXT_FILE_BYTES as usize;
    if bytes.len() > LARGE_TEXT_FILE_PREVIEW_BYTES as usize && truncated {
        bytes.truncate(LARGE_TEXT_FILE_PREVIEW_BYTES as usize);
    }

    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) => {
            let utf8_error = error.utf8_error();
            if utf8_error.error_len().is_some() || !truncated {
                return Err(io::Error::new(io::ErrorKind::InvalidData, utf8_error));
            }
            // The preview boundary may split the final UTF-8 code point. Keep
            // only the valid prefix rather than inserting a replacement glyph.
            let valid_up_to = utf8_error.valid_up_to();
            let mut bytes = error.into_bytes();
            bytes.truncate(valid_up_to);
            String::from_utf8(bytes).expect("validated UTF-8 prefix")
        }
    };
    Ok((content, truncated))
}

fn ensure_workspace_dir(path: &Path) -> Result<(), FilesystemError> {
    if !path.is_dir() {
        return Err(FilesystemError::WorkspaceMissing);
    }
    Ok(())
}

/// Join `relative` under `root` and guarantee the result stays inside `root`,
/// resolving symlinks.
///
/// `normalize_relative_path` already strips `..`, but the plain
/// `target.starts_with(root)` check that used to guard every read/write is
/// purely textual: a symlink located *inside* the workspace that points outside
/// it slips through, so a write could follow it and clobber a file beyond the
/// root (e.g. `~/.zshrc`). Canonicalizing the deepest existing ancestor (the
/// target itself may not exist yet, for writes) resolves every symlink on the
/// path and lets us re-check containment against the canonical root. A path that
/// escapes through a symlink is rejected as `OutsideWorkspace`.
fn resolve_within_root(
    root: &Path,
    normalized_relative: &Path,
) -> Result<PathBuf, FilesystemError> {
    let canon_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let target = root.join(normalized_relative);

    // Walk up from `target` to its deepest existing ancestor, recording the
    // not-yet-existing tail components, then canonicalize that ancestor so any
    // symlinks in the chain are resolved before the containment check.
    let mut probe = target.clone();
    let mut trailing: Vec<std::ffi::OsString> = Vec::new();
    let canon_existing = loop {
        match fs::canonicalize(&probe) {
            Ok(canonical) => break canonical,
            Err(_) => {
                let name = probe
                    .file_name()
                    .ok_or(FilesystemError::InvalidRelativePath)?
                    .to_os_string();
                trailing.push(name);
                if !probe.pop() {
                    return Err(FilesystemError::OutsideWorkspace);
                }
            }
        }
    };

    if !canon_existing.starts_with(&canon_root) {
        return Err(FilesystemError::OutsideWorkspace);
    }

    let mut resolved = canon_existing;
    for name in trailing.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), FilesystemError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let entry_path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dst.join(&file_name);
        if entry_path.is_dir() {
            copy_dir_recursive(&entry_path, &dest_path)?;
        } else {
            fs::copy(&entry_path, &dest_path)?;
        }
    }
    Ok(())
}

fn normalize_relative_path(relative: Option<&str>) -> Result<PathBuf, FilesystemError> {
    let raw = relative.unwrap_or("").trim();
    if raw.is_empty() {
        return Ok(PathBuf::new());
    }
    let sanitized = raw.replace('\\', "/");
    let trimmed = sanitized.trim_start_matches('/');
    let mut normalized = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::CurDir => continue,
            Component::Normal(part) => normalized.push(part),
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(FilesystemError::InvalidRelativePath);
            }
        }
    }
    Ok(normalized)
}

fn relative_path_string(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        String::new()
    } else {
        path.components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }
}

fn join_relative_string(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", base, name)
    }
}

fn directory_has_visible_entries(
    path: &Path,
    include_hidden: bool,
) -> Result<bool, FilesystemError> {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(FilesystemError::Io(err)),
    };
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let entry_path = entry.path();
        let is_dir = file_type.is_dir() || (file_type.is_symlink() && entry_path.is_dir());
        let is_file = file_type.is_file() || (file_type.is_symlink() && entry_path.is_file());

        if is_dir {
            if !include_hidden && is_hidden(&name_str) {
                continue;
            }
            return Ok(true);
        }
        if is_file {
            return Ok(true);
        }
    }
    Ok(false)
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn extract_extension(name: &OsStr) -> Option<String> {
    let name = name.to_string_lossy();
    let trimmed = name.trim();
    let idx = trimmed.rfind('.')?;
    if idx == 0 || idx == trimmed.len() - 1 {
        return None;
    }
    Some(trimmed[idx + 1..].to_ascii_lowercase())
}

fn infer_mime_type(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        // Web documents and scripts (needed for in-app HTML preview to render)
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "xml" => "application/xml; charset=utf-8",
        "txt" | "md" | "markdown" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        // Web fonts
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        // Images
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        // Audio
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        // Video
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "3gp" => "video/3gpp",
        // Other
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn compare_entries(a: &WorkspaceEntry, b: &WorkspaceEntry) -> Ordering {
    match (a.entry_type, b.entry_type) {
        (WorkspaceEntryType::Directory, WorkspaceEntryType::File) => Ordering::Less,
        (WorkspaceEntryType::File, WorkspaceEntryType::Directory) => Ordering::Greater,
        _ => a
            .name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| a.name.cmp(&b.name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn lists_files_and_non_hidden_directories() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join(".git")).unwrap();
        fs::create_dir_all(workspace.join("notes")).unwrap();
        fs::File::create(workspace.join("notes/alpha.md")).unwrap();
        fs::File::create(workspace.join("notes/hidden.txt")).unwrap();
        fs::File::create(workspace.join(".env")).unwrap();
        fs::File::create(workspace.join("diagram.svg")).unwrap();

        let service = FilesystemService::new();
        let entries = service
            .list_workspace_entries(workspace, None, false)
            .unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "notes");
        assert_eq!(entries[0].entry_type, WorkspaceEntryType::Directory);
        assert_eq!(entries[0].has_children, Some(true));
        assert_eq!(entries[1].name, ".env");
        assert_eq!(entries[1].entry_type, WorkspaceEntryType::File);
        assert_eq!(entries[2].name, "diagram.svg");
        assert_eq!(entries[2].entry_type, WorkspaceEntryType::File);
    }

    #[test]
    fn classifies_media_extensions() {
        assert_eq!(classify_media(Some("png")), Some(MediaKind::Image));
        assert_eq!(classify_media(Some("JPG")), Some(MediaKind::Image));
        assert_eq!(classify_media(Some("svg")), Some(MediaKind::Image));
        assert_eq!(classify_media(Some("mp4")), Some(MediaKind::Video));
        assert_eq!(classify_media(Some("MOV")), Some(MediaKind::Video));
        assert_eq!(classify_media(Some("txt")), None);
        assert_eq!(classify_media(Some("")), None);
        assert_eq!(classify_media(None), None);
    }

    #[test]
    fn lists_media_skipping_build_dirs_and_gitignored() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join(".git")).unwrap();
        fs::create_dir_all(workspace.join("assets")).unwrap();
        fs::create_dir_all(workspace.join("node_modules/pkg")).unwrap();
        fs::write(workspace.join(".gitignore"), "ignored.png\n").unwrap();

        fs::write(workspace.join("assets/a.png"), b"x").unwrap();
        fs::write(workspace.join("assets/b.mp4"), b"x").unwrap();
        fs::write(workspace.join("assets/notes.txt"), b"x").unwrap();
        fs::write(workspace.join("ignored.png"), b"x").unwrap();
        fs::write(workspace.join("node_modules/pkg/icon.png"), b"x").unwrap();

        let service = FilesystemService::new();
        let (items, truncated) = service.list_workspace_media(workspace, 100).unwrap();
        let paths: Vec<&str> = items.iter().map(|m| m.relative_path.as_str()).collect();

        assert!(paths.contains(&"assets/a.png"), "found: {paths:?}");
        assert!(paths.contains(&"assets/b.mp4"), "found: {paths:?}");
        assert!(
            !paths.iter().any(|p| p.ends_with("notes.txt")),
            "non-media leaked: {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "build dir leaked: {paths:?}"
        );
        assert!(
            !paths.iter().any(|p| *p == "ignored.png"),
            "gitignored leaked: {paths:?}"
        );
        assert_eq!(items.len(), 2);
        assert!(!truncated);
    }

    #[test]
    fn caps_media_at_limit_and_flags_truncation() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join(".git")).unwrap();
        for i in 0..5 {
            fs::write(workspace.join(format!("img{i}.png")), b"x").unwrap();
        }

        let service = FilesystemService::new();
        let (items, truncated) = service.list_workspace_media(workspace, 3).unwrap();
        assert_eq!(items.len(), 3);
        assert!(truncated);
    }

    #[test]
    fn includes_hidden_directories_when_enabled() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join(".secrets")).unwrap();
        fs::File::create(workspace.join(".secrets/hidden.md")).unwrap();

        let service = FilesystemService::new();
        let entries = service
            .list_workspace_entries(workspace, None, true)
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, ".secrets");
        assert_eq!(entries[0].entry_type, WorkspaceEntryType::Directory);
        assert_eq!(entries[0].has_children, Some(true));
    }

    #[test]
    fn lists_files_without_extension_filter() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::create_dir_all(workspace.join(".secrets")).unwrap();
        fs::File::create(workspace.join("src/component.tsx")).unwrap();
        fs::File::create(workspace.join("Cargo.toml")).unwrap();
        fs::File::create(workspace.join("Dockerfile")).unwrap();
        fs::File::create(workspace.join("script")).unwrap();
        fs::File::create(workspace.join(".env")).unwrap();
        fs::File::create(workspace.join(".gitignore")).unwrap();

        let service = FilesystemService::new();
        let entries = service
            .list_workspace_entries(workspace, None, false)
            .unwrap();

        assert!(entries.iter().any(|entry| entry.name == "Cargo.toml"));
        assert!(entries.iter().any(|entry| entry.name == "Dockerfile"));
        assert!(entries.iter().any(|entry| entry.name == "script"));
        assert!(entries.iter().any(|entry| entry.name == ".env"));
        assert!(entries.iter().any(|entry| entry.name == ".gitignore"));
        assert!(entries.iter().all(|entry| entry.name != ".secrets"));

        let src_entries = service
            .list_workspace_entries(workspace, Some("src"), false)
            .unwrap();
        let component = src_entries
            .iter()
            .find(|entry| entry.name == "component.tsx")
            .unwrap();
        assert_eq!(component.entry_type, WorkspaceEntryType::File);
        assert_eq!(component.extension.as_deref(), Some("tsx"));
    }

    #[test]
    fn lists_symlinked_files_and_directories() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join("actual-dir")).unwrap();
        fs::File::create(workspace.join("actual-dir/nested.ts")).unwrap();
        fs::File::create(workspace.join("actual-file.ts")).unwrap();

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                workspace.join("actual-file.ts"),
                workspace.join("linked-file.ts"),
            )
            .unwrap();
            std::os::unix::fs::symlink(workspace.join("actual-dir"), workspace.join("linked-dir"))
                .unwrap();
        }

        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(
                workspace.join("actual-file.ts"),
                workspace.join("linked-file.ts"),
            )
            .unwrap();
            std::os::windows::fs::symlink_dir(
                workspace.join("actual-dir"),
                workspace.join("linked-dir"),
            )
            .unwrap();
        }

        let service = FilesystemService::new();
        let entries = service
            .list_workspace_entries(workspace, None, false)
            .unwrap();

        let linked_file = entries
            .iter()
            .find(|entry| entry.name == "linked-file.ts")
            .unwrap();
        assert_eq!(linked_file.entry_type, WorkspaceEntryType::File);

        let linked_dir = entries
            .iter()
            .find(|entry| entry.name == "linked-dir")
            .unwrap();
        assert_eq!(linked_dir.entry_type, WorkspaceEntryType::Directory);
    }

    #[test]
    fn basic_detail_skips_metadata_and_child_probe() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join("notes")).unwrap();
        fs::File::create(workspace.join("notes/alpha.md")).unwrap();
        fs::File::create(workspace.join("diagram.svg")).unwrap();

        let service = FilesystemService::new();
        let entries = service
            .list_workspace_entries_with_detail(workspace, None, false, WorkspaceEntryDetail::Basic)
            .unwrap();

        let notes = entries.iter().find(|entry| entry.name == "notes").unwrap();
        assert_eq!(notes.entry_type, WorkspaceEntryType::Directory);
        assert_eq!(notes.has_children, None);
        assert!(notes.modified.is_none());
        assert!(notes.created.is_none());

        let file = entries
            .iter()
            .find(|entry| entry.name == "diagram.svg")
            .unwrap();
        assert_eq!(file.entry_type, WorkspaceEntryType::File);
        assert!(file.size.is_none());
        assert!(file.modified.is_none());
        assert!(file.created.is_none());
    }

    #[test]
    fn reads_workspace_file() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join("docs")).unwrap();
        let file_path = workspace.join("docs/readme.md");
        let mut file = fs::File::create(&file_path).unwrap();
        writeln!(file, "Hello Chro!").unwrap();

        let service = FilesystemService::new();
        let file = service
            .read_workspace_file(workspace, "docs/readme.md")
            .unwrap();
        assert_eq!(file.relative_path, "docs/readme.md");
        assert!(file.content.contains("Chro"));
        assert!(file.size > 0);
        assert!(!file.truncated);
    }

    #[test]
    fn large_workspace_file_returns_bounded_preview() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        let file_path = workspace.join("large.txt");
        fs::write(
            &file_path,
            vec![b'a'; MAX_INLINE_TEXT_FILE_BYTES as usize + 1],
        )
        .unwrap();

        let service = FilesystemService::new();
        let file = service.read_workspace_file(workspace, "large.txt").unwrap();
        assert!(file.truncated);
        assert_eq!(file.size, MAX_INLINE_TEXT_FILE_BYTES + 1);
        assert_eq!(file.content.len(), LARGE_TEXT_FILE_PREVIEW_BYTES as usize);
    }

    #[test]
    fn bounded_reader_handles_file_growth_after_metadata_lookup() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("growing.txt");
        fs::write(
            &file_path,
            vec![b'a'; MAX_INLINE_TEXT_FILE_BYTES as usize + 1],
        )
        .unwrap();

        let (content, truncated) = read_text_file_bounded(&file_path, 0).unwrap();
        assert!(truncated);
        assert_eq!(content.len(), LARGE_TEXT_FILE_PREVIEW_BYTES as usize);
    }

    #[test]
    fn reads_absolute_file_outside_any_workspace() {
        // A file that lives outside the workspace root entirely — the case of an
        // agent writing to a scratch directory and printing its absolute path.
        let outside = tempdir().unwrap();
        let file_path = outside.path().join("phone4.txt");
        let mut file = fs::File::create(&file_path).unwrap();
        writeln!(file, "crop data").unwrap();

        let service = FilesystemService::new();
        let read = service.read_absolute_file(&file_path).unwrap();
        assert_eq!(read.relative_path, file_path.to_string_lossy());
        assert!(read.content.contains("crop data"));
        assert!(read.size > 0);
        assert!(!read.truncated);
    }

    #[test]
    fn reads_absolute_binary_file_with_inferred_mime() {
        let outside = tempdir().unwrap();
        let file_path = outside.path().join("phone4.png");
        fs::write(&file_path, [0x89, b'P', b'N', b'G']).unwrap();

        let service = FilesystemService::new();
        let read = service.read_absolute_binary_file(&file_path).unwrap();
        assert_eq!(read.relative_path, file_path.to_string_lossy());
        assert_eq!(read.mime_type, "image/png");
        assert_eq!(fs::read(read.path).unwrap(), [0x89, b'P', b'N', b'G']);
        assert_eq!(read.size, 4);
    }

    #[test]
    fn absolute_read_rejects_directories_and_missing_paths() {
        let outside = tempdir().unwrap();
        let service = FilesystemService::new();

        let dir_err = service.read_absolute_file(outside.path()).err().unwrap();
        assert!(matches!(dir_err, FilesystemError::NotFile));

        let missing_err = service
            .read_absolute_binary_file(&outside.path().join("nope.png"))
            .err()
            .unwrap();
        assert!(matches!(missing_err, FilesystemError::NotFile));
    }

    #[test]
    fn rejects_parent_path_segments() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        let service = FilesystemService::new();
        let err = service
            .read_workspace_file(workspace, "../secrets.txt")
            .err()
            .unwrap();
        assert!(matches!(err, FilesystemError::InvalidRelativePath));
    }

    /// Writing to a symlink that lives inside the workspace but points outside it
    /// must be rejected. `..` is already blocked; a symlink is the second escape
    /// route, and following it on a write would clobber a file beyond the root.
    #[cfg(unix)]
    #[test]
    fn write_through_symlink_escaping_workspace_is_rejected() {
        use std::os::unix::fs::symlink;
        let outside = tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "original").unwrap();

        let dir = tempdir().unwrap();
        let workspace = dir.path();
        symlink(&secret, workspace.join("escape")).unwrap();

        let service = FilesystemService::new();
        let err = service
            .write_workspace_file(workspace, "escape", "overwritten")
            .err()
            .unwrap();
        assert!(matches!(err, FilesystemError::OutsideWorkspace));
        // The file outside the workspace must be untouched.
        assert_eq!(fs::read_to_string(&secret).unwrap(), "original");
    }

    /// Writing a new file *inside* a symlinked directory that escapes the
    /// workspace must also be rejected (the escape is on an intermediate
    /// component, not the leaf).
    #[cfg(unix)]
    #[test]
    fn write_into_symlinked_directory_escaping_workspace_is_rejected() {
        use std::os::unix::fs::symlink;
        let outside = tempdir().unwrap();
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        symlink(outside.path(), workspace.join("out")).unwrap();

        let service = FilesystemService::new();
        let err = service
            .write_workspace_file(workspace, "out/new.txt", "data")
            .err()
            .unwrap();
        assert!(matches!(err, FilesystemError::OutsideWorkspace));
        assert!(!outside.path().join("new.txt").exists());
    }

    /// Reading through an escaping symlink is likewise blocked.
    #[cfg(unix)]
    #[test]
    fn read_through_symlink_escaping_workspace_is_rejected() {
        use std::os::unix::fs::symlink;
        let outside = tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "top secret").unwrap();

        let dir = tempdir().unwrap();
        let workspace = dir.path();
        symlink(&secret, workspace.join("escape")).unwrap();

        let service = FilesystemService::new();
        let err = service
            .read_workspace_file(workspace, "escape")
            .err()
            .unwrap();
        assert!(matches!(err, FilesystemError::OutsideWorkspace));
    }

    /// Containment must not be over-broad: a symlink that stays *inside* the
    /// workspace is still followed and read normally.
    #[cfg(unix)]
    #[test]
    fn symlink_pointing_inside_workspace_is_allowed() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join("real")).unwrap();
        fs::write(workspace.join("real/file.txt"), "hello").unwrap();
        symlink(workspace.join("real/file.txt"), workspace.join("alias.txt")).unwrap();

        let service = FilesystemService::new();
        let read = service.read_workspace_file(workspace, "alias.txt").unwrap();
        assert!(read.content.contains("hello"));
    }

    #[test]
    fn copies_file() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join("notes")).unwrap();
        let file_path = workspace.join("notes/original.md");
        let mut file = fs::File::create(&file_path).unwrap();
        writeln!(file, "Original content").unwrap();

        let service = FilesystemService::new();
        let entry = service
            .copy_workspace_entry(workspace, "notes/original.md", "notes/original copy.md")
            .unwrap();
        assert_eq!(entry.name, "original copy.md");
        assert_eq!(entry.entry_type, WorkspaceEntryType::File);
        assert_eq!(entry.relative_path, "notes/original copy.md");

        let copied_content = fs::read_to_string(workspace.join("notes/original copy.md")).unwrap();
        assert!(copied_content.contains("Original content"));
    }

    #[test]
    fn copies_directory() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        fs::create_dir_all(workspace.join("original/sub")).unwrap();
        let file_path = workspace.join("original/note.md");
        let mut file = fs::File::create(&file_path).unwrap();
        writeln!(file, "Note content").unwrap();
        let sub_file_path = workspace.join("original/sub/nested.md");
        let mut sub_file = fs::File::create(&sub_file_path).unwrap();
        writeln!(sub_file, "Nested content").unwrap();

        let service = FilesystemService::new();
        let entry = service
            .copy_workspace_entry(workspace, "original", "original copy")
            .unwrap();
        assert_eq!(entry.name, "original copy");
        assert_eq!(entry.entry_type, WorkspaceEntryType::Directory);
        assert_eq!(entry.relative_path, "original copy");

        let copied_note = fs::read_to_string(workspace.join("original copy/note.md")).unwrap();
        assert!(copied_note.contains("Note content"));
        let copied_nested =
            fs::read_to_string(workspace.join("original copy/sub/nested.md")).unwrap();
        assert!(copied_nested.contains("Nested content"));
    }

    #[test]
    fn copy_fails_when_destination_exists() {
        let dir = tempdir().unwrap();
        let workspace = dir.path();
        let file_path = workspace.join("original.md");
        fs::File::create(&file_path).unwrap();
        let existing_path = workspace.join("existing.md");
        fs::File::create(&existing_path).unwrap();

        let service = FilesystemService::new();
        let err = service
            .copy_workspace_entry(workspace, "original.md", "existing.md")
            .err()
            .unwrap();
        assert!(matches!(err, FilesystemError::AlreadyExists));
    }
}
