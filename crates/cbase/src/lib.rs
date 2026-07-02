//! Markdown-database view engine for `.cbase` files.
//!
//! A `.cbase` defines a tabular view over workspace files: rows are files and
//! columns are frontmatter properties. This crate owns the whole pipeline:
//! parsing the YAML (or query-language) definition, indexing matching files,
//! inferring a schema, and executing filters/sort/limit into per-view results.
//! The frontend consumes the materialized [`CbaseDocument`] and renders it.

use std::path::Path;

use indexmap::IndexMap;
use serde::Deserialize;

mod document;
mod engine;
mod error;
mod frontmatter;
mod glob;
mod indexer;
mod parser;
mod property_inference;
mod query_language;
mod serializer;
mod types;
mod value;
mod yaml;

pub use document::{build_document, ensure_referenced_properties, CbaseDocument};
pub use error::CbaseError;
pub use indexer::{index_project, index_rows, FileInput};
pub use parser::parse_cbase;
pub use serializer::serialize_cbase;
pub use types::{
    CbaseDataset, CbaseDefinition, CbaseFilter, CbaseFilterCondition, CbaseProperty,
    CbasePropertyType, CbaseRow, CbaseSort, CbaseTableView, CbaseTemplate, CbaseView,
    CbaseViewResult, FilterOperator, SortDirection,
};

/// Parse, index, and materialize a `.cbase` for the given project root.
///
/// Parse failures are returned in-band as [`CbaseDocument::parse_error`] (the UI
/// renders an invalid-file state); only I/O failures during indexing surface as
/// `Err`.
pub fn query(
    root: &Path,
    content: &str,
    base_path: Option<&str>,
) -> Result<CbaseDocument, CbaseError> {
    let is_query_language = query_language::looks_like_query_language(content);
    let definition = match parse_cbase(content, base_path) {
        Ok(definition) => definition,
        Err(CbaseError::Parse(message)) => return Ok(CbaseDocument::parse_error(message)),
        Err(other) => return Err(other),
    };
    let rows = index_project(root, &definition.dataset)?;
    Ok(build_document(&definition, &rows, is_query_language))
}

/// Request payload for persisting UI-driven changes to a `.cbase` file.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistInput {
    /// Relative path of the `.cbase` file to write.
    pub base_path: String,
    /// The structurally updated definition (new columns/sort/filters).
    pub definition: CbaseDefinition,
    /// The effective property schema, used to backfill referenced properties.
    pub properties: IndexMap<String, CbaseProperty>,
}

/// Backfill any referenced-but-undeclared properties from the effective schema,
/// then serialize the definition to `.cbase` YAML ready to write to disk.
pub fn prepare_persist(input: &PersistInput) -> Result<String, CbaseError> {
    let definition = ensure_referenced_properties(input.definition.clone(), &input.properties);
    serialize_cbase(&definition)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::execute_view;
    use serde_json::{json, Value as JsonValue};

    fn row(file_path: &str, values: Vec<(&str, JsonValue)>, modified_at: Option<&str>) -> CbaseRow {
        let display_name = file_path
            .rsplit('/')
            .next()
            .unwrap_or(file_path)
            .trim_end_matches(".md")
            .to_string();
        CbaseRow {
            file_path: file_path.to_string(),
            display_name,
            modified_at: modified_at.map(|s| s.to_string()),
            values: values
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        }
    }

    #[test]
    fn parses_table_query_and_executes_clauses() {
        let query = "TABLE title, status\nFROM \"tasks\"\nWHERE status != \"done\" AND priority >= 2\nSORT priority DESC\nLIMIT 10\n";
        let definition = parse_cbase(query, None).unwrap();
        let view = &definition.views[0];

        let rows = vec![
            row(
                "tasks/a.md",
                vec![
                    ("title", json!("A")),
                    ("status", json!("todo")),
                    ("priority", json!(3)),
                ],
                None,
            ),
            row(
                "tasks/b.md",
                vec![
                    ("title", json!("B")),
                    ("status", json!("done")),
                    ("priority", json!(5)),
                ],
                None,
            ),
            row(
                "notes/c.md",
                vec![
                    ("title", json!("C")),
                    ("status", json!("todo")),
                    ("priority", json!(9)),
                ],
                None,
            ),
        ];

        let result = execute_view(
            &rows,
            view,
            &definition.properties,
            definition.filters.as_deref(),
            definition.sort.as_deref(),
        );
        assert_eq!(
            result
                .rows
                .iter()
                .map(|r| r.file_path.clone())
                .collect::<Vec<_>>(),
            vec!["tasks/a.md"]
        );
        assert_eq!(view.limit, Some(10));
    }

    #[test]
    fn supports_tag_sources_and_mtime_sorting() {
        let query =
            "TABLE title\nFROM #work OR #urgent\nWHERE contains(title, \"Roadmap\")\nSORT file.mtime DESC\n";
        let definition = parse_cbase(query, None).unwrap();
        let view = &definition.views[0];

        let rows = vec![
            row(
                "notes/one.md",
                vec![("title", json!("Roadmap alpha")), ("tags", json!(["work"]))],
                Some("2026-03-10T10:00:00.000Z"),
            ),
            row(
                "notes/two.md",
                vec![
                    ("title", json!("Roadmap beta")),
                    ("tags", json!(["urgent"])),
                ],
                Some("2026-03-11T10:00:00.000Z"),
            ),
            row(
                "notes/three.md",
                vec![
                    ("title", json!("Roadmap gamma")),
                    ("tags", json!(["personal"])),
                ],
                Some("2026-03-12T10:00:00.000Z"),
            ),
        ];

        let result = execute_view(
            &rows,
            view,
            &definition.properties,
            definition.filters.as_deref(),
            definition.sort.as_deref(),
        );
        assert_eq!(
            result
                .rows
                .iter()
                .map(|r| r.file_path.clone())
                .collect::<Vec<_>>(),
            vec!["notes/two.md", "notes/one.md"]
        );
    }

    #[test]
    fn parses_yaml_query_mode() {
        let yaml = "version: 1\nname: \"Query Cbase\"\nquery: |\n  TABLE title\n  FROM \"notes\"\n  WHERE done = false\n";
        let definition = parse_cbase(yaml, None).unwrap();
        assert_eq!(definition.name, "Query Cbase");
        assert_eq!(definition.dataset.include, vec!["**/*.md".to_string()]);
        assert_eq!(definition.views[0].default, Some(true));
    }

    #[test]
    fn rejects_unsupported_group_by() {
        let query = "TABLE title\nGROUP BY status\n";
        let error = parse_cbase(query, None).unwrap_err();
        assert!(error.to_string().contains("GROUP BY"));
    }

    #[test]
    fn parses_fenced_query_block() {
        let query = "```query\nTABLE title\nWHERE title\n```\n";
        let definition = parse_cbase(query, None).unwrap();
        assert_eq!(definition.views.len(), 1);
    }

    #[test]
    fn scopes_dataset_to_base_folder_when_from_omitted() {
        let query = "TABLE title, status\nWHERE status != \"done\"\n";
        let definition = parse_cbase(query, Some("tasks/overview/my-table.cbase")).unwrap();
        assert_eq!(
            definition.dataset.include,
            vec!["tasks/overview/**/*.md".to_string()]
        );
    }

    #[test]
    fn keeps_vault_wide_dataset_when_from_present() {
        let query = "TABLE title\nFROM \"tasks\"\n";
        let definition = parse_cbase(query, Some("tasks/overview/my-table.cbase")).unwrap();
        assert_eq!(definition.dataset.include, vec!["**/*.md".to_string()]);
    }

    #[test]
    fn query_materializes_document_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("tasks")).unwrap();
        std::fs::write(
            root.join("tasks/a.md"),
            "---\ntitle: A\nstatus: todo\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("tasks/b.md"),
            "---\ntitle: B\nstatus: done\n---\n",
        )
        .unwrap();

        let content = "version: 1\nname: Tasks\ndataset:\n  include:\n    - \"tasks/**/*.md\"\nproperties:\n  p_status:\n    key: status\n    type: text\nfilters:\n  - property: p_status\n    op: \"!=\"\n    value: done\nviews:\n  - id: v\n    name: V\n    type: table\n";
        let document = query(root, content, None).unwrap();
        assert!(document.parse_error.is_none());
        assert_eq!(document.views.len(), 1);
        assert_eq!(
            document.views[0]
                .rows
                .iter()
                .map(|r| r.file_path.clone())
                .collect::<Vec<_>>(),
            vec!["tasks/a.md"]
        );
    }
}
