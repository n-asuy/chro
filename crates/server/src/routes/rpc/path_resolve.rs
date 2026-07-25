//! Path resolution shared by file-read/write RPC endpoints.
//!
//! Agents (and humans) may supply absolute paths in chat output, tool results,
//! or pasted from a terminal — e.g. `/Users/alice/proj/src/main.rs` or
//! `/var/folders/.../worktrees/ch/foo/src/main.rs`. The endpoints, however,
//! operate against a specific workspace root (project main checkout or task-run
//! worktree). This helper normalizes any input path to either a
//! workspace-relative form (when it lives inside a known root) or an explicit
//! external absolute path (when it does not).
//!
//! Read endpoints serve external paths directly — an agent that wrote a crop to
//! `/tmp/crops/phone4.png` and printed the path should be able to preview it.
//! Mutating endpoints (write/delete) reject external paths to preserve
//! workspace containment.

use std::future::Future;
use std::path::{Path, PathBuf};

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use filesystem::{FilesystemError, WorkspaceBinaryFile, WorkspaceFile};
use runtime::{ProjectFileService, Runtime, RuntimeError};
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::ApiError;

/// The outcome of resolving a raw path against a set of workspace candidate
/// roots.
pub(crate) enum WorkspacePath {
    /// A genuinely relative input, to be joined under the caller's service root.
    /// Holds the workspace-relative form.
    Internal(String),
    /// An absolute path that matched a *known* candidate root. The file lives at
    /// `relative` under `root`, and must be read/written there via the
    /// normalizing workspace reader — NOT re-joined under the caller's service
    /// root, which may be a different checkout (e.g. a task-run worktree while
    /// the path names the project's main checkout). `relative` keeps its leading
    /// slash; the filesystem layer strips it.
    Scoped { root: PathBuf, relative: String },
    /// An absolute path that matched none of the candidate roots, so it points
    /// outside every known workspace root. Read endpoints may serve it
    /// directly; mutating endpoints must reject it.
    External(PathBuf),
}

/// macOS (APFS) and Windows filesystems are case-insensitive by default, so a
/// candidate root and an absolute path differing only in case still name the
/// same directory on disk. On those platforms the root-prefix match folds ASCII
/// case; elsewhere it stays exact.
const CASE_INSENSITIVE_FS: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// If `path` names `root` itself or a descendant of it, return the remainder
/// (empty for `root` itself, otherwise the leading-slash suffix). Returns `None`
/// when `path` merely shares a textual prefix with a different sibling
/// (`/root2` vs `/root`). Folds ASCII case on case-insensitive filesystems.
fn match_root_prefix<'a>(path: &'a str, root: &str) -> Option<&'a str> {
    if path.len() < root.len() || !path.is_char_boundary(root.len()) {
        return None;
    }
    let (head, rest) = path.split_at(root.len());
    let matches = if CASE_INSENSITIVE_FS {
        head.eq_ignore_ascii_case(root)
    } else {
        head == root
    };
    if matches && (rest.is_empty() || rest.starts_with('/')) {
        Some(rest)
    } else {
        None
    }
}

/// Resolve `raw` against the provided candidate roots.
///
/// Behavior:
/// - Empty / whitespace input → `Internal("")` (caller rejects).
/// - A leading `~` is expanded to the home directory, then resolved as absolute.
/// - Relative input (no leading `/`) → `Internal(input)` unchanged.
/// - Absolute input matching one of the candidate roots → `Scoped { root,
///   relative }`, so the file is read/written under the *matched* root rather
///   than re-joined under a caller's (possibly different) service root.
/// - Absolute input matching none of the candidates → `External(path)`.
///
/// Candidates are checked in order; the first prefix match wins. Trailing
/// slashes on candidates are tolerated.
///
/// On macOS `/var` and `/tmp` are symlinks into `/private/var` and
/// `/private/tmp`; either form may appear in agent output, in DB records, or
/// from `fs::canonicalize`. Matching is therefore done symmetrically against
/// both forms (see `prefix_variants`).
pub(crate) fn resolve_workspace_path<'a, I>(raw: &str, candidates: I) -> WorkspacePath
where
    I: IntoIterator<Item = &'a str>,
{
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return WorkspacePath::Internal(String::new());
    }
    // Expand a leading `~` to the user's home directory before anything else.
    // Agents and pasted terminal lines routinely use `~/foo`; without this it
    // is treated as a relative segment and mis-joined under the workspace root,
    // surfacing as a spurious "not a file" error. After expansion the path is
    // absolute and flows through the candidate-match / external logic below.
    let expanded = filesystem::expand_home_tilde(trimmed);
    let trimmed = expanded.as_deref().unwrap_or(trimmed);
    if !trimmed.starts_with('/') {
        return WorkspacePath::Internal(trimmed.to_string());
    }
    for candidate in candidates {
        let candidate = candidate.trim_end_matches('/');
        if candidate.is_empty() {
            continue;
        }
        for variant in prefix_variants(candidate) {
            if let Some(rest) = match_root_prefix(trimmed, &variant) {
                return WorkspacePath::Scoped {
                    root: PathBuf::from(candidate),
                    relative: rest.to_string(),
                };
            }
        }
    }
    WorkspacePath::External(PathBuf::from(trimmed))
}

/// Read a binary file (image, video, PDF, …) referenced by `raw`, resolving it
/// against `candidates` and falling back to a direct read for genuinely
/// external absolute paths.
pub(crate) async fn read_binary_resolving<R: Runtime>(
    service: &ProjectFileService<'_, R>,
    raw: &str,
    candidates: &[&str],
) -> Result<WorkspaceBinaryFile, RuntimeError> {
    match resolve_workspace_path(raw, candidates.iter().copied()) {
        WorkspacePath::Internal(relative) => {
            first_readable_root(candidates, |root| service.read_binary_file_in(root, &relative))
                .await
        }
        WorkspacePath::Scoped { root, relative } => {
            service.read_binary_file_in(&root, &relative).await
        }
        WorkspacePath::External(absolute) => service.read_binary_file_absolute(absolute).await,
    }
}

/// Stream a validated binary file instead of first copying the entire payload
/// into a `Vec<u8>`. This keeps large media/PDF responses bounded by the I/O
/// buffers and lets backpressure from the webview reach the filesystem read.
pub(crate) async fn stream_binary_response(
    binary_file: WorkspaceBinaryFile,
    cache_control: &'static str,
) -> Result<Response, ApiError> {
    let file = File::open(&binary_file.path)
        .await
        .map_err(filesystem::FilesystemError::Io)?;
    let size = file
        .metadata()
        .await
        .map_err(filesystem::FilesystemError::Io)?
        .len();
    let body = Body::from_stream(ReaderStream::new(file));

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, binary_file.mime_type)
        .header(header::CONTENT_LENGTH, size)
        .header(header::CACHE_CONTROL, cache_control)
        .body(body)
        .map_err(|error| ApiError::Internal(format!("failed to build binary response: {error}")))
}

/// Read a text file referenced by `raw`, resolving it against `candidates` and
/// falling back to a direct read for genuinely external absolute paths.
pub(crate) async fn read_text_resolving<R: Runtime>(
    service: &ProjectFileService<'_, R>,
    raw: &str,
    candidates: &[&str],
) -> Result<WorkspaceFile, RuntimeError> {
    match resolve_workspace_path(raw, candidates.iter().copied()) {
        WorkspacePath::Internal(relative) => {
            first_readable_root(candidates, |root| service.read_file_in(root, &relative)).await
        }
        WorkspacePath::Scoped { root, relative } => service.read_file_in(&root, &relative).await,
        WorkspacePath::External(absolute) => service.read_file_absolute(absolute).await,
    }
}

/// Whether a read error means "this root does not have the file" (`NotFound` /
/// `NotFile`), as opposed to a hard failure (containment violation, IO error).
/// Only a missing-file error may fall through to the next candidate root.
fn is_missing(error: &RuntimeError) -> bool {
    matches!(
        error,
        RuntimeError::Filesystem(FilesystemError::NotFound | FilesystemError::NotFile)
    )
}

/// Read a relative path against `candidates` in order, returning the first root
/// that has the file. A relative reference carries no project identity, so a
/// path shown in one project's session may name a file that lives in another
/// project's checkout; trying each candidate root (the run's own worktree
/// first, then sibling project roots) lets it resolve instead of failing under
/// the caller's root alone. A missing file falls through to the next root; any
/// other error stops immediately. If every root is missing, the first
/// missing-file error is surfaced (preserving the original "File not found").
async fn first_readable_root<'c, T, F, Fut>(
    candidates: &'c [&'c str],
    mut read_in: F,
) -> Result<T, RuntimeError>
where
    F: FnMut(&'c Path) -> Fut,
    Fut: Future<Output = Result<T, RuntimeError>> + Send,
{
    let mut first_missing: Option<RuntimeError> = None;
    for &root in candidates {
        match read_in(Path::new(root)).await {
            Ok(value) => return Ok(value),
            Err(error) if is_missing(&error) => {
                first_missing.get_or_insert(error);
            }
            Err(error) => return Err(error),
        }
    }
    Err(first_missing.unwrap_or(RuntimeError::Filesystem(FilesystemError::NotFound)))
}

/// Resolve `raw` for a mutating endpoint (write/delete), which must stay inside
/// the workspace. Returns the workspace-relative form, or a `BadRequest` if the
/// path resolves outside every candidate root.
pub(crate) fn require_internal(raw: &str, root: &str) -> Result<String, ApiError> {
    match resolve_workspace_path(raw, [root]) {
        // A single root is passed, so a `Scoped` match is against that same root:
        // its relative form is exactly what the caller writes under `root`.
        WorkspacePath::Internal(relative) | WorkspacePath::Scoped { relative, .. } => Ok(relative),
        WorkspacePath::External(_) => {
            Err(ApiError::BadRequest("path is outside the workspace".into()))
        }
    }
}

/// Expand a candidate root into every textual form that refers to the same
/// directory on the host filesystem. On macOS `/var` and `/tmp` are firmlinks
/// into `/private/var` / `/private/tmp`, so a worktree stored as
/// `/var/folders/.../foo` is the same place as `/private/var/folders/.../foo`.
/// Both forms appear in practice: tools that resolve absolute paths via
/// `realpath(3)` emit the `/private` form; pasted output and DB rows that came
/// from CLI args usually keep the short form. Without this expansion the
/// prefix strip silently misses one direction.
fn prefix_variants(candidate: &str) -> Vec<String> {
    let mut variants = vec![candidate.to_string()];
    if let Some(rest) = candidate.strip_prefix("/private/") {
        if rest == "var" || rest == "tmp" || rest.starts_with("var/") || rest.starts_with("tmp/") {
            variants.push(format!("/{rest}"));
        }
    } else if candidate == "/var"
        || candidate == "/tmp"
        || candidate.starts_with("/var/")
        || candidate.starts_with("/tmp/")
    {
        variants.push(format!("/private{candidate}"));
    }
    variants
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assert the resolution lands on `Internal` with the expected relative form.
    #[track_caller]
    fn assert_internal(path: WorkspacePath, expected: &str) {
        match path {
            WorkspacePath::Internal(relative) => assert_eq!(relative, expected),
            other => panic!("expected Internal({expected:?}), got {}", describe(&other)),
        }
    }

    /// Assert the resolution lands on `Scoped` under `root` with the expected
    /// relative form. This is the outcome for an absolute path that matched a
    /// known candidate root; the relative is read/written under the *matched*
    /// root, not a caller's service root.
    #[track_caller]
    fn assert_scoped(path: WorkspacePath, expected_root: &str, expected_relative: &str) {
        match path {
            WorkspacePath::Scoped { root, relative } => {
                assert_eq!(root, PathBuf::from(expected_root), "matched root");
                assert_eq!(relative, expected_relative, "relative");
            }
            other => panic!(
                "expected Scoped({expected_root:?}, {expected_relative:?}), got {}",
                describe(&other)
            ),
        }
    }

    /// Assert the resolution lands on `External` with the expected absolute path.
    #[track_caller]
    fn assert_external(path: WorkspacePath, expected: &str) {
        match path {
            WorkspacePath::External(absolute) => {
                assert_eq!(absolute, PathBuf::from(expected))
            }
            other => panic!("expected External({expected:?}), got {}", describe(&other)),
        }
    }

    fn describe(path: &WorkspacePath) -> String {
        match path {
            WorkspacePath::Internal(relative) => format!("Internal({relative:?})"),
            WorkspacePath::Scoped { root, relative } => format!("Scoped({root:?}, {relative:?})"),
            WorkspacePath::External(absolute) => format!("External({absolute:?})"),
        }
    }

    /// A `~/...` path whose expansion falls under a candidate root resolves to a
    /// `Scoped` read under the home root, exactly as the equivalent absolute
    /// path would.
    #[test]
    fn expands_tilde_matching_candidate_root() {
        let home = dirs::home_dir().expect("home dir");
        let root = home.to_string_lossy().into_owned();
        assert_scoped(
            resolve_workspace_path("~/docs/x.md", [root.as_str()]),
            &root,
            "/docs/x.md",
        );
    }

    /// A `~/...` path outside every candidate root resolves to its real absolute
    /// location (External), not a segment mis-joined under the workspace root.
    #[test]
    fn expands_tilde_outside_candidates_to_external() {
        let home = dirs::home_dir().expect("home dir");
        let expected = home.join("workspace/curino/note.md");
        assert_external(
            resolve_workspace_path("~/workspace/curino/note.md", ["/some/other/root"]),
            &expected.to_string_lossy(),
        );
    }

    #[test]
    fn returns_relative_unchanged() {
        assert_internal(resolve_workspace_path("docs/x.md", ["/root"]), "docs/x.md");
        assert_internal(resolve_workspace_path("./a/b", ["/root"]), "./a/b");
    }

    #[test]
    fn strips_matching_root() {
        assert_scoped(
            resolve_workspace_path("/root/docs/x.md", ["/root"]),
            "/root",
            "/docs/x.md",
        );
        assert_scoped(resolve_workspace_path("/root/", ["/root"]), "/root", "/");
        assert_scoped(resolve_workspace_path("/root", ["/root"]), "/root", "");
    }

    /// The first candidate whose prefix matches wins, and the resolution records
    /// *which* root it matched so the read happens under that checkout. This is
    /// the fix for worktree-vs-main confusion: a path naming the project main
    /// checkout must be read from the project, not re-joined under the worktree
    /// service root.
    #[test]
    fn first_match_wins_and_records_matched_root() {
        assert_scoped(
            resolve_workspace_path(
                "/var/folders/abc/worktree/docs/x.md",
                ["/var/folders/abc/worktree", "/Users/alice/proj"],
            ),
            "/var/folders/abc/worktree",
            "/docs/x.md",
        );
        assert_scoped(
            resolve_workspace_path(
                "/Users/alice/proj/docs/x.md",
                ["/var/folders/abc/worktree", "/Users/alice/proj"],
            ),
            "/Users/alice/proj",
            "/docs/x.md",
        );
    }

    /// The leading slash is what makes `External` reachable at all. A wildcard
    /// route segment cannot carry one, so an absolute path routed through a
    /// scope-relative asset URL arrives stripped and is silently re-rooted
    /// under the workspace instead of being served from its real location.
    /// Callers must therefore carry an absolute path as an encoded root plus a
    /// relative remainder (see the asset URL builders in the desktop client)
    /// rather than flattening it into a path segment.
    #[test]
    fn absolute_path_without_leading_slash_is_not_external() {
        assert_internal(
            resolve_workspace_path("Users/alice/site/index.html", ["/root"]),
            "Users/alice/site/index.html",
        );
    }

    #[test]
    fn unmatched_absolute_is_external() {
        assert_external(
            resolve_workspace_path("/other/place/x.md", ["/root"]),
            "/other/place/x.md",
        );
        // The motivating case: an agent-written crop under /tmp, outside the
        // project and worktree roots, must surface as External so the read
        // endpoints serve it directly instead of mis-joining under the root.
        assert_external(
            resolve_workspace_path(
                "/tmp/crops/phone4.png",
                ["/var/folders/abc/worktree", "/Users/alice/proj"],
            ),
            "/tmp/crops/phone4.png",
        );
    }

    #[test]
    fn tolerates_trailing_slash_on_candidate() {
        assert_scoped(
            resolve_workspace_path("/root/docs/x.md", ["/root/"]),
            "/root",
            "/docs/x.md",
        );
    }

    #[test]
    fn does_not_strip_partial_segment() {
        // "/root2" must not be stripped just because "/root" is a prefix; it is
        // a different directory and therefore external.
        assert_external(
            resolve_workspace_path("/root2/docs/x.md", ["/root"]),
            "/root2/docs/x.md",
        );
    }

    #[test]
    fn empty_candidate_is_skipped() {
        assert_scoped(
            resolve_workspace_path("/root/x.md", ["", "/root"]),
            "/root",
            "/x.md",
        );
    }

    /// `/var` is a symlink to `/private/var` on macOS. When the DB stores the
    /// worktree as `/var/folders/.../foo` but the agent emits the canonical
    /// `/private/var/folders/.../foo` (e.g. via `realpath`), the strip must
    /// still succeed.
    #[test]
    fn matches_private_var_against_var_candidate() {
        assert_scoped(
            resolve_workspace_path(
                "/private/var/folders/abc/worktree/docs/x.md",
                ["/var/folders/abc/worktree"],
            ),
            "/var/folders/abc/worktree",
            "/docs/x.md",
        );
    }

    /// The reverse: candidate stored with `/private` prefix, input without.
    #[test]
    fn matches_var_against_private_var_candidate() {
        assert_scoped(
            resolve_workspace_path(
                "/var/folders/abc/worktree/docs/x.md",
                ["/private/var/folders/abc/worktree"],
            ),
            "/private/var/folders/abc/worktree",
            "/docs/x.md",
        );
    }

    /// `/tmp` is the other firmlinked path on macOS.
    #[test]
    fn matches_private_tmp_against_tmp_candidate() {
        assert_scoped(
            resolve_workspace_path("/private/tmp/work/x.md", ["/tmp/work"]),
            "/tmp/work",
            "/x.md",
        );
    }

    /// On a case-insensitive filesystem (macOS/Windows), an absolute path that
    /// differs from the candidate root only in case still names the same
    /// directory, so it must resolve to `Scoped` under that root rather than
    /// falling through to `External` (which would read the wrong checkout, and,
    /// for mutating endpoints, wrongly reject an in-workspace path).
    #[test]
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn matches_root_case_insensitively() {
        assert_scoped(
            resolve_workspace_path("/Users/Alice/proj/src/main.rs", ["/Users/alice/proj"]),
            "/Users/alice/proj",
            "/src/main.rs",
        );
    }

    /// On a case-sensitive filesystem the exact-match behavior is preserved: a
    /// case-differing path is a different directory and stays `External`.
    #[test]
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    fn case_differing_path_is_external_on_case_sensitive_fs() {
        assert_external(
            resolve_workspace_path("/Users/Alice/proj/src/main.rs", ["/Users/alice/proj"]),
            "/Users/Alice/proj/src/main.rs",
        );
    }

    /// `/private/etc/...` (or any non-firmlinked /private subtree) must not
    /// be rewritten — only /var and /tmp are firmlinks — so it stays external.
    #[test]
    fn does_not_rewrite_non_firmlinked_private_subtree() {
        assert_external(
            resolve_workspace_path("/private/etc/passwd", ["/etc"]),
            "/private/etc/passwd",
        );
    }

    /// Only a genuinely missing file (`NotFound` / `NotFile`) may fall through
    /// to the next candidate root; every other error is a hard stop.
    #[test]
    fn is_missing_only_covers_absent_file_errors() {
        assert!(is_missing(&RuntimeError::Filesystem(
            FilesystemError::NotFound
        )));
        assert!(is_missing(&RuntimeError::Filesystem(FilesystemError::NotFile)));
        assert!(!is_missing(&RuntimeError::Filesystem(
            FilesystemError::OutsideWorkspace
        )));
        assert!(!is_missing(&RuntimeError::NotFound("run")));
    }

    fn missing() -> RuntimeError {
        RuntimeError::Filesystem(FilesystemError::NotFound)
    }

    /// A relative path missing under the first roots resolves against a later
    /// sibling root — the cross-project open. The matched root is the one that
    /// actually has the file, not merely the first candidate.
    #[tokio::test]
    async fn first_readable_root_falls_through_to_sibling() {
        let candidates = ["/worktree", "/own-project", "/sibling"];
        let result = first_readable_root(&candidates, |root| {
            let root = root.to_string_lossy().into_owned();
            async move {
                if root == "/sibling" {
                    Ok::<_, RuntimeError>(format!("read@{root}"))
                } else {
                    Err(missing())
                }
            }
        })
        .await;
        assert_eq!(result.unwrap(), "read@/sibling");
    }

    /// A hard error (e.g. containment violation) at an early root stops the
    /// walk immediately instead of masking it by reading a later root's copy.
    #[tokio::test]
    async fn first_readable_root_stops_on_hard_error() {
        let candidates = ["/a", "/b"];
        let result = first_readable_root(&candidates, |root| {
            let root = root.to_string_lossy().into_owned();
            async move {
                if root == "/a" {
                    Err::<String, _>(RuntimeError::Filesystem(FilesystemError::OutsideWorkspace))
                } else {
                    Ok("must-not-reach".to_string())
                }
            }
        })
        .await;
        assert!(matches!(
            result,
            Err(RuntimeError::Filesystem(FilesystemError::OutsideWorkspace))
        ));
    }

    /// When no root has the file, the missing-file error is surfaced so the UI
    /// still shows the original "File not found".
    #[tokio::test]
    async fn first_readable_root_all_missing_reports_not_found() {
        let candidates = ["/a", "/b"];
        let result: Result<String, _> =
            first_readable_root(&candidates, |_root| async move { Err(missing()) }).await;
        assert!(matches!(
            result,
            Err(RuntimeError::Filesystem(FilesystemError::NotFound))
        ));
    }
}
