//! Decorated file tree assembly.
//!
//! Produces, in one place, the two derivations the desktop frontend used to
//! compute in TypeScript:
//!
//! 1. A nested tree of changed files synthesized from a flat list of
//!    repo-relative paths (for the session sandbox view).
//! 2. Git status decorations: each changed file maps to its status, and the
//!    status rolls up to every ancestor folder using a dominant-status
//!    priority, so a collapsed folder still signals "something changed inside".
//!
//! Status priority and the status-kind set live here only, reusing
//! [`FileChangeStatus`] so there is a single source of truth shared with the
//! rest of the git service.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use crate::{FileChangeStatus, GitStatus};

/// A change kind that can decorate a file or folder. Mirrors
/// [`FileChangeStatus`] plus `Untracked`, which git reports separately.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DecorationStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChange,
    Untracked,
}

impl From<FileChangeStatus> for DecorationStatus {
    fn from(status: FileChangeStatus) -> Self {
        match status {
            FileChangeStatus::Added => DecorationStatus::Added,
            FileChangeStatus::Modified => DecorationStatus::Modified,
            FileChangeStatus::Deleted => DecorationStatus::Deleted,
            FileChangeStatus::Renamed => DecorationStatus::Renamed,
            FileChangeStatus::Copied => DecorationStatus::Copied,
            FileChangeStatus::TypeChange => DecorationStatus::TypeChange,
        }
    }
}

impl DecorationStatus {
    /// Higher wins when several statuses collapse onto one folder.
    fn priority(self) -> u8 {
        match self {
            DecorationStatus::Deleted => 6,
            DecorationStatus::Modified => 5,
            DecorationStatus::TypeChange => 4,
            DecorationStatus::Added | DecorationStatus::Untracked => 3,
            DecorationStatus::Renamed => 2,
            DecorationStatus::Copied => 1,
        }
    }
}

/// The dominant of two statuses (the existing one wins ties, matching the
/// `>=` comparison the frontend used).
fn dominant(existing: DecorationStatus, next: DecorationStatus) -> DecorationStatus {
    if existing.priority() >= next.priority() {
        existing
    } else {
        next
    }
}

/// Normalize a path the way git decorations expect: backslashes to forward
/// slashes, leading slashes stripped. The result is repo-relative.
fn normalize_path(raw: &str) -> String {
    raw.replace('\\', "/").trim_start_matches('/').to_string()
}

/// File- and folder-level decoration maps.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct GitDecorations {
    /// relativePath -> status, for files.
    pub files: BTreeMap<String, DecorationStatus>,
    /// ancestor folder relativePath -> dominant status of its changed
    /// descendants.
    pub folders: BTreeMap<String, DecorationStatus>,
}

/// Build decoration maps from a flat list of `(path, status)` entries. Each
/// file maps to its status; the status also rolls up to every ancestor folder,
/// with the dominant status winning on collisions.
pub fn build_decorations_from_entries(
    entries: impl IntoIterator<Item = (String, DecorationStatus)>,
) -> GitDecorations {
    let mut decorations = GitDecorations::default();

    for (raw_path, next) in entries {
        let path = normalize_path(&raw_path);
        if path.is_empty() {
            continue;
        }

        decorations
            .files
            .entry(path.clone())
            .and_modify(|existing| *existing = dominant(*existing, next))
            .or_insert(next);

        let segments: Vec<&str> = path.split('/').collect();
        let mut current = String::new();
        for segment in &segments[..segments.len().saturating_sub(1)] {
            if current.is_empty() {
                current.push_str(segment);
            } else {
                current.push('/');
                current.push_str(segment);
            }
            decorations
                .folders
                .entry(current.clone())
                .and_modify(|existing| *existing = dominant(*existing, next))
                .or_insert(next);
        }
    }

    decorations
}

/// Build decorations from a git status snapshot. Staged, unstaged, and
/// untracked entries are all folded in.
pub fn build_git_decorations(status: &GitStatus) -> GitDecorations {
    let entries = status
        .staged
        .iter()
        .chain(status.modified.iter())
        .map(|change| (change.path.clone(), DecorationStatus::from(change.status)))
        .chain(
            status
                .untracked
                .iter()
                .map(|path| (path.clone(), DecorationStatus::Untracked)),
        );

    build_decorations_from_entries(entries)
}

/// Kind of a tree node.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    File,
    Directory,
}

/// A node in the changed-files tree. Mirrors the frontend `FileNode` shape so
/// the renderer can consume it directly. Directories are fully hydrated (the
/// change set is complete, so the tree never lazy-loads).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileNode {
    pub id: String,
    pub name: String,
    pub display_name: String,
    /// Primary-root convention: `"/" + relativePath`.
    pub path: String,
    #[serde(rename = "type")]
    pub node_type: NodeKind,
    pub relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ChangedFileNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_children: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_hydrated: Option<bool>,
}

/// Intermediate builder: directories sort before files, both alphabetically,
/// and exact-duplicate paths collapse automatically (map/set keys).
#[derive(Default)]
struct DirBuilder {
    dirs: BTreeMap<String, DirBuilder>,
    files: BTreeSet<String>,
}

impl DirBuilder {
    fn insert(&mut self, segments: &[&str]) {
        match segments {
            [] => {}
            [file] => {
                self.files.insert((*file).to_string());
            }
            [head, rest @ ..] => {
                self.dirs.entry((*head).to_string()).or_default().insert(rest);
            }
        }
    }

    fn into_nodes(self, prefix: &str) -> Vec<ChangedFileNode> {
        let join = |name: &str| -> String {
            if prefix.is_empty() {
                name.to_string()
            } else {
                format!("{prefix}/{name}")
            }
        };

        // Directories first (sorted), then files (sorted).
        let mut nodes = Vec::with_capacity(self.dirs.len() + self.files.len());
        for (name, child) in self.dirs {
            let rel = join(&name);
            let children = child.into_nodes(&rel);
            nodes.push(ChangedFileNode {
                id: format!("changed-dir:{rel}"),
                name: name.clone(),
                display_name: name,
                path: format!("/{rel}"),
                node_type: NodeKind::Directory,
                relative_path: rel,
                children: Some(children),
                has_children: Some(true),
                is_hydrated: Some(true),
            });
        }
        for name in self.files {
            let rel = join(&name);
            nodes.push(ChangedFileNode {
                id: format!("changed-file:{rel}"),
                name: name.clone(),
                display_name: name,
                path: format!("/{rel}"),
                node_type: NodeKind::File,
                relative_path: rel,
                children: None,
                has_children: None,
                is_hydrated: None,
            });
        }
        nodes
    }
}

/// Build a nested tree of changed files from a flat list of repo-relative
/// paths. Directories are synthesized for every path segment.
pub fn build_changed_files_tree(paths: &[String]) -> Vec<ChangedFileNode> {
    let mut root = DirBuilder::default();
    for raw in paths {
        let rel = normalize_path(raw);
        if rel.is_empty() {
            continue;
        }
        let segments: Vec<&str> = rel.split('/').collect();
        root.insert(&segments);
    }
    root.into_nodes("")
}

/// Collect the `path` of every directory node — used to expand-all on load.
pub fn collect_directory_paths(nodes: &[ChangedFileNode]) -> Vec<String> {
    let mut paths = Vec::new();
    fn walk(nodes: &[ChangedFileNode], out: &mut Vec<String>) {
        for node in nodes {
            if node.node_type == NodeKind::Directory {
                out.push(node.path.clone());
                if let Some(children) = &node.children {
                    walk(children, out);
                }
            }
        }
    }
    walk(nodes, &mut paths);
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FileChange;

    fn status(staged: Vec<FileChange>, modified: Vec<FileChange>, untracked: Vec<&str>) -> GitStatus {
        GitStatus {
            staged,
            modified,
            untracked: untracked.into_iter().map(str::to_string).collect(),
            has_changes: true,
        }
    }

    fn change(path: &str, status: FileChangeStatus) -> FileChange {
        FileChange {
            path: path.to_string(),
            status,
        }
    }

    // --- decorations (parity with git-status-decoration.test.ts) ---

    #[test]
    fn empty_status_yields_empty_maps() {
        let decorations = build_git_decorations(&status(vec![], vec![], vec![]));
        assert!(decorations.files.is_empty());
        assert!(decorations.folders.is_empty());
    }

    #[test]
    fn maps_each_changed_file_to_its_status() {
        let decorations = build_git_decorations(&status(
            vec![],
            vec![change("src/app.ts", FileChangeStatus::Modified)],
            vec!["src/new.ts"],
        ));
        assert_eq!(
            decorations.files.get("src/app.ts"),
            Some(&DecorationStatus::Modified)
        );
        assert_eq!(
            decorations.files.get("src/new.ts"),
            Some(&DecorationStatus::Untracked)
        );
    }

    #[test]
    fn rolls_status_up_to_every_ancestor_folder() {
        let decorations = build_git_decorations(&status(
            vec![],
            vec![change("apps/desktop/src/app.ts", FileChangeStatus::Modified)],
            vec![],
        ));
        assert_eq!(
            decorations.folders.get("apps"),
            Some(&DecorationStatus::Modified)
        );
        assert_eq!(
            decorations.folders.get("apps/desktop"),
            Some(&DecorationStatus::Modified)
        );
        assert_eq!(
            decorations.folders.get("apps/desktop/src"),
            Some(&DecorationStatus::Modified)
        );
        // The file's own path is not a folder entry.
        assert!(!decorations.folders.contains_key("apps/desktop/src/app.ts"));
    }

    #[test]
    fn picks_dominant_status_when_folder_holds_several_changes() {
        let decorations = build_git_decorations(&status(
            vec![change("src/b.ts", FileChangeStatus::Deleted)],
            vec![change("src/a.ts", FileChangeStatus::Modified)],
            vec![],
        ));
        // deleted outranks modified
        assert_eq!(decorations.folders.get("src"), Some(&DecorationStatus::Deleted));
    }

    #[test]
    fn normalizes_leading_slashes_and_backslashes() {
        let decorations = build_git_decorations(&status(
            vec![],
            vec![change("/win\\path\\file.ts", FileChangeStatus::Added)],
            vec![],
        ));
        assert_eq!(
            decorations.files.get("win/path/file.ts"),
            Some(&DecorationStatus::Added)
        );
    }

    // --- tree (parity with changed-files-tree.test.ts) ---

    #[test]
    fn nests_changed_files_under_synthesized_hydrated_directories() {
        let tree = build_changed_files_tree(&[
            "src/app.ts".into(),
            "src/lib/util.ts".into(),
            "README.md".into(),
        ]);

        // Directories sort before files: src/ then README.md
        let names: Vec<&str> = tree.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["src", "README.md"]);

        let src = &tree[0];
        assert_eq!(src.node_type, NodeKind::Directory);
        assert_eq!(src.path, "/src");
        assert_eq!(src.relative_path, "src");
        assert_eq!(src.is_hydrated, Some(true));

        let src_children = src.children.as_ref().unwrap();
        let child_names: Vec<&str> = src_children.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(child_names, ["lib", "app.ts"]);

        let app = src_children.iter().find(|n| n.name == "app.ts").unwrap();
        assert_eq!(app.path, "/src/app.ts");
        assert_eq!(app.relative_path, "src/app.ts");
    }

    #[test]
    fn does_not_duplicate_a_path_that_appears_twice() {
        let tree = build_changed_files_tree(&["a.ts".into(), "a.ts".into()]);
        assert_eq!(tree.len(), 1);
    }

    #[test]
    fn collects_every_directory_path_for_expand_all() {
        let tree = build_changed_files_tree(&["apps/desktop/src/app.ts".into()]);
        let mut paths = collect_directory_paths(&tree);
        paths.sort();
        assert_eq!(paths, ["/apps", "/apps/desktop", "/apps/desktop/src"]);
    }
}
