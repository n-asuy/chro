//! Probe a path-like reference before the UI renders it as a link.
//!
//! Agent output is full of text that *looks* like a path (`src/main.rs:12`,
//! `~/notes/report.html`, `chro-ai.com`). Deciding link-ness from the shape
//! alone produces links that do nothing when clicked, and forces the click
//! itself to discover where the file lives. This endpoint answers the question
//! once, up front: does this reference name something that exists, is it a file
//! or a directory, and what is its absolute location?
//!
//! The renderer decorates only what resolves here, and activation reuses the
//! absolute path, so a click costs no further resolution round trip.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::path_resolve::{resolve_workspace_path, WorkspacePath};
use crate::{ApiError, AppState};

/// One request carries every reference a rendered message wants to check, so a
/// conversation full of code spans costs one round trip instead of one per span.
#[derive(Debug, Deserialize)]
pub(super) struct PathProbeRequest {
    /// Raw references as written in agent output, `:line[:col]` included.
    pub(super) paths: Vec<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct PathProbeBatchResponse {
    /// One entry per requested path, in request order.
    results: Vec<PathProbeResponse>,
}

/// Bounds the filesystem work a single request can ask for. Far above any real
/// message; a larger batch means the caller is not the renderer.
const MAX_PROBE_PATHS: usize = 256;

#[derive(Debug, Serialize)]
pub(super) struct PathProbeResponse {
    exists: bool,
    /// `"file"` or `"directory"` when the reference resolves, else absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    absolute_path: Option<String>,
    /// The workspace root the resolved path lives under, when it lives under
    /// one. Absent for paths outside every candidate root.
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    column: Option<u32>,
}

impl PathProbeResponse {
    fn missing() -> Self {
        Self {
            exists: false,
            kind: None,
            absolute_path: None,
            root: None,
            relative_path: None,
            line: None,
            column: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    File,
    Directory,
}

impl EntryKind {
    fn as_str(self) -> &'static str {
        match self {
            EntryKind::File => "file",
            EntryKind::Directory => "directory",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProbedPath {
    kind: EntryKind,
    absolute: PathBuf,
    line: Option<u32>,
    column: Option<u32>,
}

/// Split a trailing `:line[:column]` suffix off a reference.
///
/// Only all-digit trailing segments are consumed, and at most two of them, so
/// `C:/src/main.rs` and `note:draft` keep their colons. The caller probes the
/// unsplit form first, because a file may legitimately be named `foo:12`.
fn split_position(raw: &str) -> (&str, Option<u32>, Option<u32>) {
    let (head, first) = match split_trailing_number(raw) {
        Some(split) => split,
        None => return (raw, None, None),
    };
    match split_trailing_number(head) {
        Some((head, second)) => (head, Some(second), Some(first)),
        None => (head, Some(first), None),
    }
}

fn split_trailing_number(raw: &str) -> Option<(&str, u32)> {
    let (head, tail) = raw.rsplit_once(':')?;
    if head.is_empty() || tail.is_empty() {
        return None;
    }
    tail.parse().ok().map(|number| (head, number))
}

async fn entry_kind(path: &Path) -> Option<EntryKind> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    Some(if metadata.is_dir() {
        EntryKind::Directory
    } else {
        EntryKind::File
    })
}

/// Resolve `raw` to something that exists on disk, or `None`.
///
/// Tries, in order: the reference verbatim, then with a `:line[:col]` suffix
/// removed. Each form is expanded (`~` to home) and probed as an absolute path,
/// or joined against every candidate root in priority order.
async fn probe_reference(raw: &str, candidates: &[String]) -> Option<ProbedPath> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (stripped, line, column) = split_position(trimmed);
    let mut forms = vec![(trimmed, None, None)];
    if stripped != trimmed {
        forms.push((stripped, line, column));
    }

    for (reference, line, column) in forms {
        let expanded = filesystem::expand_home_tilde(reference);
        let reference = expanded.as_deref().unwrap_or(reference);
        let path = Path::new(reference);

        if path.is_absolute() {
            if let Some(kind) = entry_kind(path).await {
                return Some(ProbedPath {
                    kind,
                    absolute: path.to_path_buf(),
                    line,
                    column,
                });
            }
            continue;
        }

        for candidate in candidates {
            let joined = Path::new(candidate).join(reference);
            if let Some(kind) = entry_kind(&joined).await {
                return Some(ProbedPath {
                    kind,
                    absolute: joined,
                    line,
                    column,
                });
            }
        }
    }

    None
}

/// Probe every reference in `request` against `candidates`, in request order.
pub(super) async fn probe_paths(
    state: &AppState,
    request: PathProbeRequest,
    candidates: &[String],
) -> Result<PathProbeBatchResponse, ApiError> {
    if request.paths.len() > MAX_PROBE_PATHS {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_PROBE_PATHS} paths may be probed per request"
        )));
    }

    let results = futures::future::try_join_all(
        request
            .paths
            .iter()
            .map(|raw| probe_path(state, raw, candidates)),
    )
    .await?;
    Ok(PathProbeBatchResponse { results })
}

/// Probe `raw`, falling back to the workspace name index for bare references
/// (`report.md`) that no candidate root resolves by direct join.
async fn probe_path(
    state: &AppState,
    raw: &str,
    candidates: &[String],
) -> Result<PathProbeResponse, ApiError> {
    let probed = match probe_reference(raw, candidates).await {
        Some(probed) => Some(probed),
        None => probe_via_name_index(state, raw, candidates).await?,
    };

    let Some(probed) = probed else {
        return Ok(PathProbeResponse::missing());
    };

    let absolute = probed.absolute.to_string_lossy().into_owned();
    let (root, relative_path) =
        match resolve_workspace_path(&absolute, candidates.iter().map(String::as_str)) {
            WorkspacePath::Scoped { root, relative } => (
                Some(root.to_string_lossy().into_owned()),
                Some(relative.trim_start_matches('/').to_string()),
            ),
            _ => (None, None),
        };

    Ok(PathProbeResponse {
        exists: true,
        kind: Some(probed.kind.as_str()),
        absolute_path: Some(absolute),
        root,
        relative_path,
        line: probed.line,
        column: probed.column,
    })
}

/// The name index resolves references that name a file without locating it —
/// a bare `report.md`, or a suffix like `state/files-store.ts`. It only answers
/// for genuinely relative references; absolute paths either exist or do not.
async fn probe_via_name_index(
    state: &AppState,
    raw: &str,
    candidates: &[String],
) -> Result<Option<ProbedPath>, ApiError> {
    let trimmed = raw.trim();
    let (stripped, line, column) = split_position(trimmed);
    if filesystem::expand_home_tilde(stripped)
        .as_deref()
        .map(|expanded| Path::new(expanded).is_absolute())
        .unwrap_or_else(|| Path::new(stripped).is_absolute())
    {
        return Ok(None);
    }

    for candidate in candidates {
        let root = Path::new(candidate);
        let Some(relative) = super::projects::resolve_in_root(state, root, stripped).await else {
            continue;
        };
        let absolute = root.join(relative.trim_start_matches('/'));
        if let Some(kind) = entry_kind(&absolute).await {
            return Ok(Some(ProbedPath {
                kind,
                absolute,
                line,
                column,
            }));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_line_and_column_suffixes() {
        assert_eq!(split_position("src/main.rs"), ("src/main.rs", None, None));
        assert_eq!(
            split_position("src/main.rs:12"),
            ("src/main.rs", Some(12), None)
        );
        assert_eq!(
            split_position("src/main.rs:12:5"),
            ("src/main.rs", Some(12), Some(5))
        );
    }

    #[test]
    fn keeps_colons_that_are_not_positions() {
        assert_eq!(
            split_position("C:/src/main.rs"),
            ("C:/src/main.rs", None, None)
        );
        assert_eq!(split_position("note:draft"), ("note:draft", None, None));
        assert_eq!(split_position("trailing:"), ("trailing:", None, None));
    }

    #[tokio::test]
    async fn resolves_a_path_relative_to_a_candidate_root() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join("src")).expect("mkdir");
        std::fs::write(root.path().join("src/main.rs"), "fn main() {}").expect("write");
        let candidates = vec![root.path().to_string_lossy().into_owned()];

        let probed = probe_reference("src/main.rs:12:5", &candidates)
            .await
            .expect("resolved");
        assert_eq!(probed.kind, EntryKind::File);
        assert_eq!(probed.absolute, root.path().join("src/main.rs"));
        assert_eq!((probed.line, probed.column), (Some(12), Some(5)));
    }

    #[tokio::test]
    async fn reports_directories_distinctly() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(root.path().join("docs")).expect("mkdir");
        let candidates = vec![root.path().to_string_lossy().into_owned()];

        let probed = probe_reference("docs", &candidates)
            .await
            .expect("resolved");
        assert_eq!(probed.kind, EntryKind::Directory);
    }

    /// The reported failure: a home-relative path outside every workspace root
    /// must resolve to its real location instead of being joined under a root.
    #[tokio::test]
    async fn resolves_a_home_relative_path_outside_every_root() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let workspace = tempfile::tempdir().expect("tempdir");
        let outside = tempfile::tempdir_in(&home).expect("tempdir in home");
        std::fs::write(outside.path().join("report.html"), "<html>").expect("write");
        let leaf = outside
            .path()
            .strip_prefix(&home)
            .expect("under home")
            .to_string_lossy()
            .into_owned();
        let candidates = vec![workspace.path().to_string_lossy().into_owned()];

        let probed = probe_reference(&format!("~/{leaf}/report.html"), &candidates)
            .await
            .expect("resolved");
        assert_eq!(probed.kind, EntryKind::File);
        assert_eq!(probed.absolute, outside.path().join("report.html"));
    }

    /// A file whose name really ends in `:<digits>` is found before the
    /// position-stripped form is tried.
    #[tokio::test]
    async fn prefers_a_file_named_like_a_position_suffix() {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::write(root.path().join("weird:12"), "x").expect("write");
        std::fs::write(root.path().join("weird"), "x").expect("write");
        let candidates = vec![root.path().to_string_lossy().into_owned()];

        let probed = probe_reference("weird:12", &candidates)
            .await
            .expect("resolved");
        assert_eq!(probed.absolute, root.path().join("weird:12"));
        assert_eq!(probed.line, None);
    }

    #[tokio::test]
    async fn rejects_references_that_do_not_exist() {
        let root = tempfile::tempdir().expect("tempdir");
        let candidates = vec![root.path().to_string_lossy().into_owned()];

        assert!(probe_reference("src/missing.rs", &candidates)
            .await
            .is_none());
        assert!(probe_reference("/nowhere/at/all.txt", &candidates)
            .await
            .is_none());
        assert!(probe_reference("   ", &candidates).await.is_none());
    }
}
