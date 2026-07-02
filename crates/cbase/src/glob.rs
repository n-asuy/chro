//! Glob pattern matching for dataset include/exclude rules.
//!
//! A small, purpose-built glob dialect: `**/` spans directory levels, `*`
//! matches within a single segment, and `?` matches a single non-separator
//! character. Patterns are translated to anchored regexes.

use regex::Regex;

use crate::types::CbaseDataset;

const REGEX_SPECIAL: &str = ".+^${}()|[]\\";

/// Translate a single glob pattern into an anchored regex source string.
fn glob_to_regex(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut regex = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '*' && chars.get(i + 1) == Some(&'*') {
            if chars.get(i + 2) == Some(&'/') {
                // `**/` matches zero or more directory levels.
                regex.push_str("(?:.+/)?");
                i += 3;
            } else {
                // `**` at the end matches everything.
                regex.push_str(".*");
                i += 2;
            }
        } else if ch == '*' {
            regex.push_str("[^/]*");
            i += 1;
        } else if ch == '?' {
            regex.push_str("[^/]");
            i += 1;
        } else if REGEX_SPECIAL.contains(ch) {
            regex.push('\\');
            regex.push(ch);
            i += 1;
        } else {
            regex.push(ch);
            i += 1;
        }
    }
    regex.push('$');
    regex
}

/// Compile a glob pattern into a regex. Invalid patterns never match.
fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(&glob_to_regex(pattern)).ok()
}

/// Pre-compiled include/exclude matcher for a dataset.
pub struct DatasetMatcher {
    include: Vec<Regex>,
    exclude: Vec<Regex>,
}

impl DatasetMatcher {
    pub fn new(dataset: &CbaseDataset) -> Self {
        let include = dataset.include.iter().filter_map(|p| compile(p)).collect();
        let exclude = dataset
            .exclude
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter_map(|p| compile(p))
            .collect();
        Self { include, exclude }
    }

    /// True when `path` matches an include pattern and no exclude pattern.
    pub fn matches(&self, path: &str) -> bool {
        if !self.include.iter().any(|re| re.is_match(path)) {
            return false;
        }
        !self.exclude.iter().any(|re| re.is_match(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(include: &[&str], exclude: &[&str], path: &str) -> bool {
        let dataset = CbaseDataset {
            include: include.iter().map(|s| s.to_string()).collect(),
            exclude: if exclude.is_empty() {
                None
            } else {
                Some(exclude.iter().map(|s| s.to_string()).collect())
            },
        };
        DatasetMatcher::new(&dataset).matches(path)
    }

    #[test]
    fn matches_simple_glob() {
        assert!(matches(&["*.md"], &[], "note.md"));
        assert!(!matches(&["*.md"], &[], "note.txt"));
    }

    #[test]
    fn matches_directory_glob() {
        assert!(matches(&["tasks/**/*.md"], &[], "tasks/todo.md"));
        assert!(matches(&["tasks/**/*.md"], &[], "tasks/sub/todo.md"));
        assert!(!matches(&["tasks/**/*.md"], &[], "other/todo.md"));
    }

    #[test]
    fn handles_exclude_patterns() {
        assert!(matches(&["**/*.md"], &["templates/**"], "note.md"));
        assert!(!matches(
            &["**/*.md"],
            &["templates/**"],
            "templates/default.md"
        ));
    }

    #[test]
    fn handles_multiple_include_patterns() {
        let include = ["tasks/**/*.md", "issues/**/*.md"];
        assert!(matches(&include, &[], "tasks/t1.md"));
        assert!(matches(&include, &[], "issues/i1.md"));
        assert!(!matches(&include, &[], "notes/n1.md"));
    }

    #[test]
    fn single_star_does_not_match_separator() {
        assert!(matches(&["tasks/*.md"], &[], "tasks/todo.md"));
        assert!(!matches(&["tasks/*.md"], &[], "tasks/sub/todo.md"));
    }
}
