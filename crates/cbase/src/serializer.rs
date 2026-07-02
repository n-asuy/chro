//! Serialize a definition back to `.cbase` YAML.
//!
//! The wire types are shaped to match the on-disk schema exactly, so a plain
//! YAML serialization round-trips through [`crate::parser::parse_cbase`]. This
//! is used to persist UI-driven changes (columns, sort, filters) to disk.

use crate::error::CbaseError;
use crate::types::CbaseDefinition;

/// Serialize a definition to `.cbase` YAML.
pub fn serialize_cbase(definition: &CbaseDefinition) -> Result<String, CbaseError> {
    serde_yaml::to_string(definition)
        .map_err(|e| CbaseError::Parse(format!("Failed to serialize .cbase: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse_cbase;

    const MINIMAL_YAML: &str = "version: 1\nname: Test\ndataset:\n  include:\n    - \"**/*.md\"\nproperties:\n  title:\n    key: title\n    type: text\nviews:\n  - id: default\n    name: Default\n    type: table\n    table:\n      columns:\n        - title\n";

    #[test]
    fn roundtrips_minimal_definition() {
        let original = parse_cbase(MINIMAL_YAML, None).unwrap();
        let serialized = serialize_cbase(&original).unwrap();
        let reparsed = parse_cbase(&serialized, None).unwrap();

        assert_eq!(reparsed.name, original.name);
        assert_eq!(reparsed.dataset, original.dataset);
        assert_eq!(
            reparsed.properties.keys().collect::<Vec<_>>(),
            original.properties.keys().collect::<Vec<_>>()
        );
        assert_eq!(reparsed.views.len(), original.views.len());
        assert_eq!(
            reparsed.views[0].table.as_ref().map(|t| &t.columns),
            original.views[0].table.as_ref().map(|t| &t.columns)
        );
    }

    #[test]
    fn preserves_sort_and_filters() {
        let yaml = "version: 1\nname: With Sort\ndataset:\n  include:\n    - \"docs/**/*.md\"\n  exclude:\n    - \"docs/drafts/**\"\nproperties:\n  status:\n    key: status\n    type: select\n    options:\n      - open\n      - closed\n  priority:\n    key: priority\n    type: number\nfilters:\n  - property: status\n    op: \"!=\"\n    value: closed\nsort:\n  - by: priority\n    dir: desc\nviews:\n  - id: main\n    name: Main\n    type: table\n    default: true\n    table:\n      columns:\n        - status\n        - priority\n      column_widths:\n        status: 200\n";

        let original = parse_cbase(yaml, None).unwrap();
        let serialized = serialize_cbase(&original).unwrap();
        let reparsed = parse_cbase(&serialized, None).unwrap();

        assert_eq!(
            reparsed.dataset.exclude,
            Some(vec!["docs/drafts/**".to_string()])
        );
        assert_eq!(reparsed.filters.as_ref().map(|f| f.len()), Some(1));
        assert_eq!(reparsed.sort, original.sort);
        assert_eq!(reparsed.views[0].default, Some(true));
        assert_eq!(
            reparsed.views[0]
                .table
                .as_ref()
                .and_then(|t| t.column_widths.as_ref())
                .and_then(|w| w.get("status"))
                .copied(),
            Some(200.0)
        );
        assert_eq!(
            reparsed.properties["status"].options,
            Some(vec!["open".to_string(), "closed".to_string()])
        );
    }
}
