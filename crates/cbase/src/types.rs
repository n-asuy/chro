//! Wire types for the `.cbase` view definition format.
//!
//! A `.cbase` describes a tabular view over workspace files: rows are files and
//! columns are frontmatter properties. These structs are the JSON contract with
//! the frontend, so their serde field names mirror the TypeScript declarations
//! exactly (a mix of snake_case for on-disk schema fields and camelCase for the
//! runtime row/result envelope).

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Property value type for a column.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CbasePropertyType {
    Text,
    Number,
    Checkbox,
    Date,
    Select,
    MultiSelect,
    Url,
}

/// A column definition mapping a frontmatter (or `file.*`) key to a typed cell.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CbaseProperty {
    /// Frontmatter key this property maps to (e.g. `title`, `file.name`).
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub property_type: CbasePropertyType,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub options: Option<Vec<String>>,
}

/// Comparison operators usable in filters.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterOperator {
    #[serde(rename = "=")]
    Eq,
    #[serde(rename = "!=")]
    Ne,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = "<=")]
    Le,
    #[serde(rename = ">=")]
    Ge,
    #[serde(rename = "contains")]
    Contains,
    #[serde(rename = "not_contains")]
    NotContains,
    #[serde(rename = "starts_with")]
    StartsWith,
    #[serde(rename = "ends_with")]
    EndsWith,
    #[serde(rename = "is_empty")]
    IsEmpty,
    #[serde(rename = "is_not_empty")]
    IsNotEmpty,
}

/// A single leaf filter condition.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CbaseFilterCondition {
    pub property: String,
    pub op: FilterOperator,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub value: Option<JsonValue>,
}

/// A filter tree: either a leaf condition or a boolean combinator.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum CbaseFilter {
    And { and: Vec<CbaseFilter> },
    Or { or: Vec<CbaseFilter> },
    Not { not: Box<CbaseFilter> },
    Condition(CbaseFilterCondition),
}

/// Sort direction.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SortDirection {
    Asc,
    Desc,
}

/// A single sort key.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CbaseSort {
    pub by: String,
    pub dir: SortDirection,
}

/// Table-view rendering configuration.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct CbaseTableView {
    pub columns: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub column_widths: Option<IndexMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub row_height: Option<f64>,
}

/// A named view over the dataset. Only `table` is supported today.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CbaseView {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filters: Option<Vec<CbaseFilter>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sort: Option<Vec<CbaseSort>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub limit: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub table: Option<CbaseTableView>,
}

/// Template for creating new rows (files) from this view.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CbaseTemplate {
    pub folder: String,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frontmatter: Option<IndexMap<String, JsonValue>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub body: Option<String>,
}

/// Which files become rows.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CbaseDataset {
    pub include: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub exclude: Option<Vec<String>>,
}

/// The parsed root `.cbase` document.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CbaseDefinition {
    pub version: i64,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    pub dataset: CbaseDataset,
    pub properties: IndexMap<String, CbaseProperty>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filters: Option<Vec<CbaseFilter>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sort: Option<Vec<CbaseSort>>,
    pub views: Vec<CbaseView>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub template: Option<CbaseTemplate>,
}

/// A single indexed row (one file).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CbaseRow {
    pub file_path: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub modified_at: Option<String>,
    pub values: IndexMap<String, JsonValue>,
}

/// Result of executing one view: filtered + sorted + limited rows.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CbaseViewResult {
    pub view: CbaseView,
    pub rows: Vec<CbaseRow>,
    pub total_count: i64,
    /// Offset of the first returned row within the filtered/sorted view.
    #[serde(default)]
    pub page_offset: i64,
    /// Whether more rows remain after this response page.
    #[serde(default)]
    pub has_more: bool,
}

impl CbaseProperty {
    pub fn new(key: impl Into<String>, property_type: CbasePropertyType) -> Self {
        Self {
            key: key.into(),
            label: None,
            property_type,
            required: None,
            default: None,
            options: None,
        }
    }
}
