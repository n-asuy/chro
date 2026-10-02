//! Repository-relative directory addresses.
//!
//! A task is "homed" at one directory of its project. The address is a
//! normalized repo-relative path with forward slashes and no leading or
//! trailing slash; the empty string is the repository root.

/// Normalize a user- or git-supplied path into a directory address.
///
/// Returns `None` when the path escapes the repository (`..` segments) or is
/// absolute; `Some("")` for the root.
pub fn normalize_home_dir(raw: &str) -> Option<String> {
    let cleaned = raw.trim().replace('\\', "/");
    if cleaned.starts_with('/') || is_windows_absolute(&cleaned) {
        return None;
    }
    let mut segments = Vec::new();
    for segment in cleaned.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            other => segments.push(other),
        }
    }
    Some(segments.join("/"))
}

fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// The deepest directory containing every path in `paths`.
///
/// Each entry is a repo-relative *file* path; its parent directory is what
/// counts. Returns `None` when no usable path is given.
pub fn common_ancestor_dir<S: AsRef<str>>(paths: &[S]) -> Option<String> {
    let mut common: Option<Vec<String>> = None;
    for raw in paths {
        // Git always separates components with '/'. Its literal file names
        // must not go through caller-input cleanup (trim or '\\' replacement).
        let file = raw.as_ref();
        if file.trim().is_empty() || file.starts_with('/') || file.split('/').any(|s| s == "..") {
            continue;
        }
        let mut dir: Vec<String> = file.split('/').map(str::to_string).collect();
        dir.pop();
        common = Some(match common {
            None => dir,
            Some(current) => current
                .iter()
                .zip(dir.iter())
                .take_while(|(a, b)| a == b)
                .map(|(a, _)| a.clone())
                .collect(),
        });
    }
    common.map(|segments| segments.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_dots() {
        assert_eq!(normalize_home_dir("apps/desktop/").as_deref(), Some("apps/desktop"));
        assert_eq!(normalize_home_dir("./apps//desktop").as_deref(), Some("apps/desktop"));
        assert_eq!(normalize_home_dir("apps\\desktop").as_deref(), Some("apps/desktop"));
        assert_eq!(normalize_home_dir("").as_deref(), Some(""));
        assert_eq!(normalize_home_dir(" . ").as_deref(), Some(""));
    }

    #[test]
    fn rejects_paths_that_escape_the_repository() {
        assert_eq!(normalize_home_dir("../other"), None);
        assert_eq!(normalize_home_dir("apps/../../x"), None);
        assert_eq!(normalize_home_dir("/abs/path"), None);
        assert_eq!(normalize_home_dir("C:/abs"), None);
    }

    #[test]
    fn single_file_is_homed_at_its_directory() {
        assert_eq!(
            common_ancestor_dir(&["apps/desktop/src/a.ts"]).as_deref(),
            Some("apps/desktop/src")
        );
    }

    #[test]
    fn root_file_is_homed_at_root() {
        assert_eq!(common_ancestor_dir(&["README.md"]).as_deref(), Some(""));
        assert_eq!(
            common_ancestor_dir(&["README.md", "apps/desktop/a.ts"]).as_deref(),
            Some("")
        );
    }

    #[test]
    fn shared_prefix_is_the_lowest_common_ancestor() {
        assert_eq!(
            common_ancestor_dir(&[
                "apps/desktop/src/a.ts",
                "apps/desktop/src/b/c.ts",
                "apps/desktop/package.json",
            ])
            .as_deref(),
            Some("apps/desktop")
        );
        assert_eq!(
            common_ancestor_dir(&["crates/server/src/lib.rs", "apps/desktop/src/a.ts"]).as_deref(),
            Some("")
        );
    }

    #[test]
    fn empty_or_invalid_input_has_no_address() {
        let none: [&str; 0] = [];
        assert_eq!(common_ancestor_dir(&none), None);
        assert_eq!(common_ancestor_dir(&["", "  "]), None);
        assert_eq!(common_ancestor_dir(&["../escape.rs"]), None);
    }
}
