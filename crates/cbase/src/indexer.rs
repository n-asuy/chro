//! Workspace indexing.
//!
//! Walks the project tree once (gitignore-aware), keeps the files matching the
//! dataset, and extracts each file's frontmatter into a row. Running this in one
//! place avoids the per-file network round-trips the previous client-side
//! indexer incurred.

use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use ignore::WalkBuilder;

use crate::error::CbaseError;
use document::frontmatter::extract_properties;
use crate::glob::DatasetMatcher;
use crate::types::{CbaseDataset, CbaseRow};

/// A candidate file fed into the pure indexer.
pub struct FileInput {
    pub relative_path: String,
    pub content: String,
    pub modified_at: Option<String>,
}

/// Index a set of in-memory files: keep those matching the dataset and extract
/// their frontmatter. Pure and deterministic; results are sorted by path.
pub fn index_rows(files: &[FileInput], dataset: &CbaseDataset) -> Vec<CbaseRow> {
    let matcher = DatasetMatcher::new(dataset);
    let mut rows: Vec<CbaseRow> = files
        .iter()
        .filter(|file| matcher.matches(&file.relative_path))
        .map(|file| CbaseRow {
            file_path: file.relative_path.clone(),
            display_name: document::name::display_name(&file.relative_path),
            modified_at: file.modified_at.clone(),
            values: extract_properties(&file.content),
        })
        .collect();
    rows.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    rows
}

/// Walk the project root and index every file matching the dataset.
///
/// The walk is gitignore-aware but includes dotfiles (so `.claude/**` style
/// datasets resolve); files that cannot be read are skipped.
pub fn index_project(root: &Path, dataset: &CbaseDataset) -> Result<Vec<CbaseRow>, CbaseError> {
    let matcher = DatasetMatcher::new(dataset);
    let mut rows: Vec<CbaseRow> = Vec::new();

    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .build();

    for entry in walker.flatten() {
        if entry.file_type().is_none_or(|ft| !ft.is_file()) {
            continue;
        }
        let path = entry.path();
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative_path = to_relative_string(relative);
        if relative_path.is_empty()
            || relative
                .components()
                .any(|component| component.as_os_str() == ".git")
        {
            continue;
        }
        if !matcher.matches(&relative_path) {
            continue;
        }
        // Only the leading frontmatter block is needed; never read the body.
        let Ok(values) = document::frontmatter::read_file_properties(path) else {
            continue;
        };
        let modified_at = path
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339_opts(SecondsFormat::Millis, true));

        rows.push(CbaseRow {
            file_path: relative_path.clone(),
            display_name: document::name::display_name(&relative_path),
            modified_at,
            values,
        });
    }

    rows.sort_by(|a, b| a.file_path.cmp(&b.file_path));
    Ok(rows)
}



fn to_relative_string(relative: &Path) -> String {
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use tempfile::tempdir;

    fn dataset(include: &[&str]) -> CbaseDataset {
        CbaseDataset {
            include: include.iter().map(|s| s.to_string()).collect(),
            exclude: None,
        }
    }

    #[test]
    fn index_rows_filters_by_glob_and_extracts_frontmatter() {
        let files = vec![
            FileInput {
                relative_path: ".claude/skills/alpha/SKILL.md".to_string(),
                content: "---\ntitle: Alpha Skill\n---\nBody".to_string(),
                modified_at: None,
            },
            FileInput {
                relative_path: "notes/other.md".to_string(),
                content: "---\ntitle: Other\n---\n".to_string(),
                modified_at: None,
            },
        ];
        let rows = index_rows(&files, &dataset(&[".claude/skills/**/*.md"]));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, ".claude/skills/alpha/SKILL.md");
        assert_eq!(rows[0].display_name, "SKILL");
        assert_eq!(rows[0].modified_at, None);
        assert_eq!(rows[0].values.get("title"), Some(&json!("Alpha Skill")));
    }

    #[test]
    fn index_rows_preserves_modified_timestamp() {
        let files = vec![FileInput {
            relative_path: "latest.md".to_string(),
            content: "---\ntitle: latest\n---\n".to_string(),
            modified_at: Some("2026-02-26T05:49:25.000Z".to_string()),
        }];
        let rows = index_rows(&files, &dataset(&["**/*.md"]));
        assert_eq!(
            rows[0].modified_at.as_deref(),
            Some("2026-02-26T05:49:25.000Z")
        );
        assert_eq!(rows[0].display_name, "latest");
    }

    #[test]
    fn index_project_walks_nested_files() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join(".claude/skills/alpha")).unwrap();
        fs::write(
            root.join(".claude/skills/alpha/SKILL.md"),
            "---\ntitle: Alpha Skill\n---\nBody",
        )
        .unwrap();
        fs::write(root.join("ignored.txt"), "not markdown").unwrap();

        let rows = index_project(root, &dataset(&[".claude/skills/**/*.md"])).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].file_path, ".claude/skills/alpha/SKILL.md");
        assert_eq!(rows[0].values.get("title"), Some(&json!("Alpha Skill")));
        assert!(rows[0].modified_at.is_some());
    }

    #[test]
    fn index_project_respects_gitignore() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join(".gitignore"), "secret/\n").unwrap();
        fs::create_dir_all(root.join("secret")).unwrap();
        fs::write(root.join("secret/hidden.md"), "---\ntitle: Hidden\n---\n").unwrap();
        fs::write(root.join("visible.md"), "---\ntitle: Visible\n---\n").unwrap();

        let rows = index_project(root, &dataset(&["**/*.md"])).unwrap();
        let paths: Vec<&str> = rows.iter().map(|r| r.file_path.as_str()).collect();
        assert!(paths.contains(&"visible.md"));
        assert!(!paths.iter().any(|p| p.contains("hidden")));
    }
}
