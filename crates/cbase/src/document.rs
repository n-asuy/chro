//! The materialized view document handed to the UI.
//!
//! Combines the parsed definition, the effective (inferred) property schema, and
//! the executed result of every view into a single payload, so the frontend can
//! render and switch views without re-querying.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::engine::execute_view;
use crate::property_inference::merge_inferred_properties;
use crate::types::{CbaseDefinition, CbaseFilter, CbaseProperty, CbaseRow, CbaseViewResult};

/// Everything the UI needs to render a `.cbase`: the parsed definition, the
/// effective property schema, and per-view results.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CbaseDocument {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition: Option<CbaseDefinition>,
    pub properties: IndexMap<String, CbaseProperty>,
    pub views: Vec<CbaseViewResult>,
    pub is_query_language: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
}

impl CbaseDocument {
    /// A document representing a parse failure (shown as an invalid-file state).
    pub fn parse_error(message: String) -> Self {
        Self {
            definition: None,
            properties: IndexMap::new(),
            views: Vec::new(),
            is_query_language: false,
            parse_error: Some(message),
        }
    }
}

/// Build the materialized document from a parsed definition and indexed rows.
pub fn build_document(
    definition: &CbaseDefinition,
    rows: &[CbaseRow],
    is_query_language: bool,
) -> CbaseDocument {
    let properties = merge_inferred_properties(&definition.properties, rows);

    let views = definition
        .views
        .iter()
        .map(|view| {
            execute_view(
                rows,
                view,
                &properties,
                definition.filters.as_deref(),
                definition.sort.as_deref(),
            )
        })
        .collect();

    CbaseDocument {
        definition: Some(definition.clone()),
        properties,
        views,
        is_query_language,
        parse_error: None,
    }
}

/// Ensure every property referenced by columns/sort/filters exists in the
/// definition, backfilling missing ones from `available` (the effective schema).
///
/// This centralizes the schema backfill that previously happened ad hoc in the
/// UI whenever a column, sort key, or filter referenced an inferred property.
pub fn ensure_referenced_properties(
    mut definition: CbaseDefinition,
    available: &IndexMap<String, CbaseProperty>,
) -> CbaseDefinition {
    let mut referenced: HashSet<String> = HashSet::new();

    if let Some(filters) = &definition.filters {
        collect_filter_property_ids(filters, &mut referenced);
    }
    if let Some(sort) = &definition.sort {
        for spec in sort {
            referenced.insert(spec.by.clone());
        }
    }
    for view in &definition.views {
        if let Some(filters) = &view.filters {
            collect_filter_property_ids(filters, &mut referenced);
        }
        if let Some(sort) = &view.sort {
            for spec in sort {
                referenced.insert(spec.by.clone());
            }
        }
        if let Some(table) = &view.table {
            for column in &table.columns {
                referenced.insert(column.clone());
            }
        }
    }

    for id in referenced {
        if definition.properties.contains_key(&id) {
            continue;
        }
        if let Some(property) = available.get(&id) {
            definition.properties.insert(id, property.clone());
        }
    }

    definition
}

fn collect_filter_property_ids(filters: &[CbaseFilter], out: &mut HashSet<String>) {
    for filter in filters {
        collect_one(filter, out);
    }
}

fn collect_one(filter: &CbaseFilter, out: &mut HashSet<String>) {
    match filter {
        CbaseFilter::And { and } => collect_filter_property_ids(and, out),
        CbaseFilter::Or { or } => collect_filter_property_ids(or, out),
        CbaseFilter::Not { not } => collect_one(not, out),
        CbaseFilter::Condition(condition) => {
            out.insert(condition.property.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_cbase;
    use crate::types::{CbaseProperty, CbasePropertyType};
    use serde_json::json;

    fn row(file_path: &str, values: Vec<(&str, serde_json::Value)>) -> CbaseRow {
        CbaseRow {
            file_path: file_path.to_string(),
            display_name: file_path.to_string(),
            modified_at: None,
            values: values
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        }
    }

    const BASE_YAML: &str = "version: 1\nname: Tasks\ndataset:\n  include:\n    - \"**/*.md\"\nproperties:\n  file_path:\n    key: file.path\n    type: text\nviews:\n  - id: all\n    name: All\n    type: table\n    default: true\n    table:\n      columns:\n        - file_path\n";

    #[test]
    fn build_document_executes_every_view() {
        let definition = parse_cbase(BASE_YAML, None).unwrap();
        let rows = vec![row("a.md", vec![("title", json!("A"))])];
        let document = build_document(&definition, &rows, false);
        assert_eq!(document.views.len(), 1);
        assert_eq!(document.views[0].rows.len(), 1);
        // Effective schema gains built-ins and the inferred `title` property.
        assert!(document.properties.values().any(|p| p.key == "title"));
        assert!(document.properties.values().any(|p| p.key == "file.name"));
    }

    #[test]
    fn ensure_referenced_backfills_inferred_columns() {
        let definition = parse_cbase(BASE_YAML, None).unwrap();
        let mut available = definition.properties.clone();
        available.insert(
            "auto_title".to_string(),
            CbaseProperty::new("title", CbasePropertyType::Text),
        );

        // A column references the inferred property that is not yet declared.
        let mut updated = definition.clone();
        updated.views[0].table.as_mut().unwrap().columns =
            vec!["file_path".to_string(), "auto_title".to_string()];

        let result = ensure_referenced_properties(updated, &available);
        assert!(result.properties.contains_key("auto_title"));
        assert_eq!(result.properties["auto_title"].key, "title");
    }
}
