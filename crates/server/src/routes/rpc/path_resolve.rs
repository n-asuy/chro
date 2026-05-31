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

use std::path::PathBuf;

use filesystem::{WorkspaceBinaryFile, WorkspaceFile};
use runtime::{ProjectFileService, Runtime, RuntimeError};

use crate::ApiError;

/// The outcome of resolving a raw path against a set of workspace candidate
/// roots.
pub(crate) enum WorkspacePath {
    /// A workspace-internal path — either originally relative, or an absolute
    /// path that matched a candidate root (the matching prefix is stripped,
    /// leaving a leading-slash form). Safe to join under the workspace root by
    /// the filesystem layer.
    Internal(String),
    /// An absolute path that matched none of the candidate roots, so it points
    /// outside every known workspace root. Read endpoints may serve it
    /// directly; mutating endpoints must reject it.
    External(PathBuf),
}

/// Resolve `raw` against the provided candidate roots.
///
/// Behavior:
/// - Empty / whitespace input → `Internal("")` (caller rejects).
/// - Relative input (no leading `/`) → `Internal(input)` unchanged.
/// - Absolute input matching one of the candidate roots → `Internal` with the
///   root prefix stripped (always starts with `/`, or is empty for the root
///   itself).
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
    if !trimmed.starts_with('/') {
        return WorkspacePath::Internal(trimmed.to_string());
    }
    for candidate in candidates {
        let candidate = candidate.trim_end_matches('/');
        if candidate.is_empty() {
            continue;
        }
        for variant in prefix_variants(candidate) {
            if trimmed == variant {
                return WorkspacePath::Internal(String::new());
            }
            if let Some(rest) = trimmed.strip_prefix(&variant) {
                if rest.starts_with('/') {
                    return WorkspacePath::Internal(rest.to_string());
                }
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
        WorkspacePath::Internal(relative) => service.read_binary_file(&relative).await,
        WorkspacePath::External(absolute) => service.read_binary_file_absolute(absolute).await,
    }
}

/// Read a text file referenced by `raw`, resolving it against `candidates` and
/// falling back to a direct read for genuinely external absolute paths.
pub(crate) async fn read_text_resolving<R: Runtime>(
    service: &ProjectFileService<'_, R>,
    raw: &str,
    candidates: &[&str],
) -> Result<WorkspaceFile, RuntimeError> {
    match resolve_workspace_path(raw, candidates.iter().copied()) {
        WorkspacePath::Internal(relative) => service.read_file(&relative).await,
        WorkspacePath::External(absolute) => service.read_file_absolute(absolute).await,
    }
}

/// Resolve `raw` for a mutating endpoint (write/delete), which must stay inside
/// the workspace. Returns the workspace-relative form, or a `BadRequest` if the
/// path resolves outside every candidate root.
pub(crate) fn require_internal(raw: &str, root: &str) -> Result<String, ApiError> {
    match resolve_workspace_path(raw, [root]) {
        WorkspacePath::Internal(relative) => Ok(relative),
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
    fn assert_internal(path: WorkspacePath, expected: &str) {
        match path {
            WorkspacePath::Internal(relative) => assert_eq!(relative, expected),
            WorkspacePath::External(absolute) => {
                panic!("expected Internal({expected:?}), got External({absolute:?})")
            }
        }
    }

    /// Assert the resolution lands on `External` with the expected absolute path.
    fn assert_external(path: WorkspacePath, expected: &str) {
        match path {
            WorkspacePath::External(absolute) => {
                assert_eq!(absolute, PathBuf::from(expected))
            }
            WorkspacePath::Internal(relative) => {
                panic!("expected External({expected:?}), got Internal({relative:?})")
            }
        }
    }

    #[test]
    fn returns_relative_unchanged() {
        assert_internal(resolve_workspace_path("docs/x.md", ["/root"]), "docs/x.md");
        assert_internal(resolve_workspace_path("./a/b", ["/root"]), "./a/b");
    }

    #[test]
    fn strips_matching_root() {
        assert_internal(
            resolve_workspace_path("/root/docs/x.md", ["/root"]),
            "/docs/x.md",
        );
        assert_internal(resolve_workspace_path("/root/", ["/root"]), "/");
        assert_internal(resolve_workspace_path("/root", ["/root"]), "");
    }

    #[test]
    fn first_match_wins() {
        assert_internal(
            resolve_workspace_path(
                "/var/folders/abc/worktree/docs/x.md",
                ["/var/folders/abc/worktree", "/Users/alice/proj"],
            ),
            "/docs/x.md",
        );
        assert_internal(
            resolve_workspace_path(
                "/Users/alice/proj/docs/x.md",
                ["/var/folders/abc/worktree", "/Users/alice/proj"],
            ),
            "/docs/x.md",
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
        assert_internal(
            resolve_workspace_path("/root/docs/x.md", ["/root/"]),
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
        assert_internal(resolve_workspace_path("/root/x.md", ["", "/root"]), "/x.md");
    }

    /// `/var` is a symlink to `/private/var` on macOS. When the DB stores the
    /// worktree as `/var/folders/.../foo` but the agent emits the canonical
    /// `/private/var/folders/.../foo` (e.g. via `realpath`), the strip must
    /// still succeed.
    #[test]
    fn matches_private_var_against_var_candidate() {
        assert_internal(
            resolve_workspace_path(
                "/private/var/folders/abc/worktree/docs/x.md",
                ["/var/folders/abc/worktree"],
            ),
            "/docs/x.md",
        );
    }

    /// The reverse: candidate stored with `/private` prefix, input without.
    #[test]
    fn matches_var_against_private_var_candidate() {
        assert_internal(
            resolve_workspace_path(
                "/var/folders/abc/worktree/docs/x.md",
                ["/private/var/folders/abc/worktree"],
            ),
            "/docs/x.md",
        );
    }

    /// `/tmp` is the other firmlinked path on macOS.
    #[test]
    fn matches_private_tmp_against_tmp_candidate() {
        assert_internal(
            resolve_workspace_path("/private/tmp/work/x.md", ["/tmp/work"]),
            "/x.md",
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
}
