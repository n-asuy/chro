//! Schema inference.
//!
//! Augments the explicitly declared properties with built-in `file.*` columns
//! and properties discovered from row frontmatter, inferring a column type from
//! the observed values.

use std::collections::HashSet;

use chrono::{DateTime, NaiveDate, NaiveDateTime};
use indexmap::IndexMap;
use serde_json::Value as JsonValue;

use crate::types::{CbaseProperty, CbasePropertyType, CbaseRow};

struct BuiltIn {
    key: &'static str,
    label: &'static str,
    property_type: CbasePropertyType,
}

const BUILT_IN_PROPERTIES: &[BuiltIn] = &[
    BuiltIn {
        key: "file.name",
        label: "Name",
        property_type: CbasePropertyType::Text,
    },
    BuiltIn {
        key: "file.path",
        label: "Path",
        property_type: CbasePropertyType::Text,
    },
    BuiltIn {
        key: "file.folder",
        label: "Folder",
        property_type: CbasePropertyType::Text,
    },
    BuiltIn {
        key: "file.mtime",
        label: "Modified",
        property_type: CbasePropertyType::Date,
    },
    BuiltIn {
        key: "file.ext",
        label: "Extension",
        property_type: CbasePropertyType::Text,
    },
];

/// Merge explicit properties with inferred built-in and frontmatter properties.
/// Explicit declarations always win; built-ins and frontmatter keys only fill
/// gaps. Insertion order is preserved so column ordering stays stable.
pub fn merge_inferred_properties(
    explicit: &IndexMap<String, CbaseProperty>,
    rows: &[CbaseRow],
) -> IndexMap<String, CbaseProperty> {
    let mut merged = explicit.clone();
    let mut known_keys: HashSet<String> = explicit.values().map(|prop| prop.key.clone()).collect();

    for built_in in BUILT_IN_PROPERTIES {
        if known_keys.contains(built_in.key) {
            continue;
        }
        let id = make_unique_property_id(built_in.key, &merged);
        merged.insert(
            id,
            CbaseProperty {
                key: built_in.key.to_string(),
                label: Some(built_in.label.to_string()),
                property_type: built_in.property_type,
                required: None,
                default: None,
                options: None,
            },
        );
        known_keys.insert(built_in.key.to_string());
    }

    // Collect candidate values per frontmatter key, in first-seen order.
    let mut values_by_key: IndexMap<String, Vec<JsonValue>> = IndexMap::new();
    for row in rows {
        for (key, value) in &row.values {
            if known_keys.contains(key) {
                continue;
            }
            values_by_key
                .entry(key.clone())
                .or_default()
                .push(value.clone());
        }
    }

    for (key, values) in &values_by_key {
        if known_keys.contains(key) {
            continue;
        }
        let id = make_unique_property_id(key, &merged);
        merged.insert(
            id,
            CbaseProperty {
                key: key.clone(),
                label: Some(default_label(key)),
                property_type: infer_property_type(values),
                required: None,
                default: None,
                options: None,
            },
        );
        known_keys.insert(key.clone());
    }

    merged
}

fn sanitize_property_id(key: &str) -> String {
    let lower = key.to_lowercase();
    let mut slug = String::new();
    let mut prev_underscore = false;
    for ch in lower.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            slug.push('_');
            prev_underscore = true;
        }
    }
    let slug = slug.trim_matches('_');
    if slug.is_empty() {
        "auto_property".to_string()
    } else {
        format!("auto_{slug}")
    }
}

fn make_unique_property_id(key: &str, properties: &IndexMap<String, CbaseProperty>) -> String {
    let base = sanitize_property_id(key);
    let mut id = base.clone();
    let mut suffix = 2;
    while properties.contains_key(&id) {
        id = format!("{base}_{suffix}");
        suffix += 1;
    }
    id
}

fn infer_property_type(values: &[JsonValue]) -> CbasePropertyType {
    let samples: Vec<&JsonValue> = values
        .iter()
        .filter(|value| {
            !value.is_null() && !matches!(value, JsonValue::String(s) if s.trim().is_empty())
        })
        .collect();

    if samples.is_empty() {
        return CbasePropertyType::Text;
    }
    if samples.iter().all(|v| v.is_array()) {
        return CbasePropertyType::MultiSelect;
    }
    if samples.iter().all(|v| v.is_boolean()) {
        return CbasePropertyType::Checkbox;
    }
    if samples.iter().all(|v| v.is_number()) {
        return CbasePropertyType::Number;
    }
    if samples
        .iter()
        .all(|v| v.as_str().is_some_and(looks_like_date))
    {
        return CbasePropertyType::Date;
    }
    if samples
        .iter()
        .all(|v| v.as_str().is_some_and(looks_like_url))
    {
        return CbasePropertyType::Url;
    }
    CbasePropertyType::Text
}

fn looks_like_date(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
        || NaiveDate::parse_from_str(value, "%Y/%m/%d").is_ok()
        || DateTime::parse_from_rfc3339(value).is_ok()
        || NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").is_ok()
}

fn looks_like_url(value: &str) -> bool {
    let value = value.trim();
    (value.starts_with("http://") || value.starts_with("https://"))
        && !value.chars().any(char::is_whitespace)
        && value.len() > "https://".len()
}

fn default_label(key: &str) -> String {
    let spaced = key.replace('.', " ");
    let mut label = String::new();
    let mut prev_space = false;
    for ch in spaced.chars() {
        if ch == '_' || ch == '-' {
            if !prev_space {
                label.push(' ');
                prev_space = true;
            }
        } else {
            label.push(ch);
            prev_space = false;
        }
    }
    let label = label.trim();
    if label.is_empty() {
        return key.to_string();
    }
    let mut chars = label.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => key.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(file_path: &str, values: Vec<(&str, JsonValue)>) -> CbaseRow {
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

    fn sample_rows() -> Vec<CbaseRow> {
        vec![
            row(
                "notes/alpha.md",
                vec![
                    ("title", json!("Alpha")),
                    ("priority", json!(2)),
                    ("done", json!(false)),
                    ("tags", json!(["work", "writing"])),
                    ("due", json!("2025-01-10")),
                    ("website", json!("https://example.com/alpha")),
                ],
            ),
            row(
                "notes/beta.md",
                vec![
                    ("title", json!("Beta")),
                    ("priority", json!(5)),
                    ("done", json!(true)),
                    ("tags", json!(["personal"])),
                    ("due", json!("2025-02-11")),
                    ("website", json!("https://example.com/beta")),
                ],
            ),
        ]
    }

    fn by_key(
        merged: &IndexMap<String, CbaseProperty>,
    ) -> std::collections::HashMap<String, CbaseProperty> {
        merged
            .values()
            .map(|prop| (prop.key.clone(), prop.clone()))
            .collect()
    }

    #[test]
    fn adds_built_in_and_frontmatter_properties() {
        let merged = merge_inferred_properties(&IndexMap::new(), &sample_rows());
        let map = by_key(&merged);

        assert_eq!(map["file.name"].label.as_deref(), Some("Name"));
        assert_eq!(map["file.path"].label.as_deref(), Some("Path"));
        assert_eq!(map["title"].property_type, CbasePropertyType::Text);
        assert_eq!(map["priority"].property_type, CbasePropertyType::Number);
        assert_eq!(map["done"].property_type, CbasePropertyType::Checkbox);
        assert_eq!(map["tags"].property_type, CbasePropertyType::MultiSelect);
        assert_eq!(map["due"].property_type, CbasePropertyType::Date);
        assert_eq!(map["website"].property_type, CbasePropertyType::Url);
    }

    #[test]
    fn keeps_explicit_properties_as_source_of_truth() {
        let mut explicit = IndexMap::new();
        explicit.insert(
            "name".to_string(),
            CbaseProperty {
                key: "file.name".to_string(),
                label: Some("Custom name".to_string()),
                property_type: CbasePropertyType::Text,
                required: None,
                default: None,
                options: None,
            },
        );
        explicit.insert(
            "title".to_string(),
            CbaseProperty {
                key: "title".to_string(),
                label: Some("Headline".to_string()),
                property_type: CbasePropertyType::Text,
                required: None,
                default: None,
                options: None,
            },
        );

        let merged = merge_inferred_properties(&explicit, &sample_rows());

        assert_eq!(merged["name"].label.as_deref(), Some("Custom name"));
        assert_eq!(merged["title"].label.as_deref(), Some("Headline"));
        assert_eq!(merged.values().filter(|p| p.key == "file.name").count(), 1);
        assert_eq!(merged.values().filter(|p| p.key == "title").count(), 1);
    }
}
