use std::borrow::Cow;

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};

/// Minimal file diff payload for UI streaming.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Diff {
    pub change: DiffChangeKind,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub old_content: Option<String>,
    pub new_content: Option<String>,
    pub content_omitted: bool,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_binary: bool,
}

impl Diff {
    pub fn path_key(&self) -> Option<&str> {
        self.new_path
            .as_deref()
            .or_else(|| self.old_path.as_deref())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffChangeKind {
    Added,
    Deleted,
    Modified,
    Renamed,
    Copied,
    PermissionChange,
}

/// Converts a replace diff to a unified diff hunk without the hunk header.
pub fn create_unified_diff_hunk(old: &str, new: &str) -> String {
    let old = ensure_newline(old);
    let new = ensure_newline(new);
    let diff = TextDiff::from_lines(&old, &new);

    let mut out = String::new();
    let old_count = diff.old_slices().len();
    let new_count = diff.new_slices().len();
    out.push_str(&format!("@@ -1,{old_count} +1,{new_count} @@\n"));

    for change in diff.iter_all_changes() {
        let sign = match change.tag() {
            ChangeTag::Equal => ' ',
            ChangeTag::Delete => '-',
            ChangeTag::Insert => '+',
        };
        out.push(sign);
        out.push_str(change.value());
    }

    out
}

/// Creates a full unified diff with the file path in the header.
pub fn create_unified_diff(file_path: &str, old: &str, new: &str) -> String {
    let mut out = String::new();
    out.push_str(format!("--- a/{file_path}\n+++ b/{file_path}\n").as_str());
    out.push_str(&create_unified_diff_hunk(old, new));
    out
}

/// Number of line insertions/deletions between two snapshots.
pub fn compute_line_change_counts(old: &str, new: &str) -> (usize, usize) {
    let old = ensure_newline(old);
    let new = ensure_newline(new);
    let diff = TextDiff::from_lines(&old, &new);

    let mut additions = 0usize;
    let mut deletions = 0usize;
    for change in diff.iter_all_changes() {
        match change.tag() {
            ChangeTag::Insert => additions += 1,
            ChangeTag::Delete => deletions += 1,
            ChangeTag::Equal => {}
        }
    }

    (additions, deletions)
}

fn ensure_newline(line: &str) -> Cow<'_, str> {
    if line.ends_with('\n') {
        Cow::Borrowed(line)
    } else {
        let mut owned = line.to_owned();
        owned.push('\n');
        Cow::Owned(owned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unified_diff_contains_hunk() {
        let hunk = create_unified_diff_hunk("hello", "hello world");
        assert!(hunk.starts_with("@@"));
    }

    #[test]
    fn compute_counts() {
        let (add, del) = compute_line_change_counts("a\n", "a\nb\n");
        assert_eq!((add, del), (1, 0));
    }
}
