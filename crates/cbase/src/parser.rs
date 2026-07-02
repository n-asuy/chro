//! Parser and validator for the `.cbase` YAML format.
//!
//! Produces a validated [`CbaseDefinition`], or delegates to the query language
//! when the content looks like a query. Validation errors carry human-readable
//! messages mirroring the on-disk schema field that failed.

use indexmap::IndexMap;
use serde_yaml::Value as Yaml;

use crate::error::CbaseError;
use crate::query_language::{looks_like_query_language, parse_to_definition, Meta};
use crate::types::{
    CbaseDataset, CbaseDefinition, CbaseFilter, CbaseFilterCondition, CbaseProperty,
    CbasePropertyType, CbaseSort, CbaseTableView, CbaseTemplate, CbaseView, FilterOperator,
    SortDirection,
};
use crate::yaml::yaml_to_json;

type ParseResult<T> = Result<T, CbaseError>;

fn err<T>(message: impl Into<String>) -> ParseResult<T> {
    Err(CbaseError::Parse(message.into()))
}

/// Parse `.cbase` content into a validated definition.
///
/// `base_path` is the relative path of the `.cbase` file, used to scope the
/// default dataset when the query language omits a `FROM` clause.
pub fn parse_cbase(content: &str, base_path: Option<&str>) -> ParseResult<CbaseDefinition> {
    if looks_like_query_language(content) {
        return parse_to_definition(content, None, base_path).map_err(CbaseError::Parse);
    }

    let raw: Yaml = match serde_yaml::from_str(content) {
        Ok(value) => value,
        Err(e) => {
            if looks_like_query_language(content) {
                return parse_to_definition(content, None, base_path).map_err(CbaseError::Parse);
            }
            return err(format!("Invalid YAML: {e}"));
        }
    };

    let Yaml::Mapping(map) = &raw else {
        if let Yaml::String(text) = &raw {
            if looks_like_query_language(text) {
                return parse_to_definition(text, None, base_path).map_err(CbaseError::Parse);
            }
        }
        return err("Base file must be a YAML object or a query block");
    };

    // version
    if get(map, "version").and_then(Yaml::as_i64) != Some(1) {
        return err(format!(
            "Unsupported version: {}. Expected 1",
            display_opt(get(map, "version"))
        ));
    }

    // name
    let name = match get(map, "name").and_then(Yaml::as_str) {
        Some(name) if !name.trim().is_empty() => name.to_string(),
        _ => return err("'name' is required and must be a non-empty string"),
    };

    // description
    let description = get(map, "description")
        .filter(|v| !v.is_null())
        .map(coerce_to_string);

    // Query-language mode
    if let Some(query) = get(map, "query").filter(|v| !v.is_null()) {
        let query_text = match query.as_str() {
            Some(text) if !text.trim().is_empty() => text,
            _ => return err("'query' must be a non-empty string"),
        };

        let has_legacy_fields = ["dataset", "properties", "views", "filters", "sort"]
            .iter()
            .any(|key| get(map, key).is_some_and(|v| !v.is_null()));
        if has_legacy_fields {
            return err(
                "When 'query' is set, dataset/properties/views/filters/sort must be omitted",
            );
        }

        return parse_to_definition(
            query_text,
            Some(Meta {
                name: Some(name),
                description,
            }),
            base_path,
        )
        .map_err(CbaseError::Parse);
    }

    let dataset = parse_dataset(get(map, "dataset"))?;
    let properties = parse_properties(get(map, "properties"))?;
    let filters = match get(map, "filters") {
        Some(value) if !value.is_null() => Some(parse_filters(value, "filters", &properties)?),
        _ => None,
    };
    let sort = match get(map, "sort") {
        Some(value) if !value.is_null() => Some(parse_sort_list(value, "sort", &properties)?),
        _ => None,
    };
    let views = parse_views(get(map, "views"), &properties)?;
    let template = match get(map, "template") {
        Some(value) if !value.is_null() => Some(parse_template(value)?),
        _ => None,
    };

    Ok(CbaseDefinition {
        version: 1,
        name,
        description,
        dataset,
        properties,
        filters,
        sort,
        views,
        template,
    })
}

fn parse_dataset(raw: Option<&Yaml>) -> ParseResult<CbaseDataset> {
    let Some(Yaml::Mapping(map)) = raw else {
        return err("'dataset' is required and must be an object");
    };

    let include = match get(map, "include") {
        Some(Yaml::Sequence(items)) if !items.is_empty() => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| CbaseError::parse("dataset.include items must be strings"))
            })
            .collect::<ParseResult<Vec<_>>>()?,
        _ => {
            return err("'dataset.include' must be a non-empty array of glob patterns");
        }
    };

    let exclude = match get(map, "exclude") {
        None | Some(Yaml::Null) => None,
        Some(Yaml::Sequence(items)) => Some(
            items
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(|s| s.to_string())
                        .ok_or_else(|| CbaseError::parse("dataset.exclude items must be strings"))
                })
                .collect::<ParseResult<Vec<_>>>()?,
        ),
        Some(_) => return err("dataset.exclude must be an array"),
    };

    Ok(CbaseDataset { include, exclude })
}

fn parse_properties(raw: Option<&Yaml>) -> ParseResult<IndexMap<String, CbaseProperty>> {
    let Some(Yaml::Mapping(map)) = raw else {
        return err("'properties' is required and must be an object");
    };

    let mut result = IndexMap::new();
    for (id_value, value) in map {
        let id = id_value.as_str().unwrap_or_default().to_string();
        let Yaml::Mapping(prop) = value else {
            return err(format!("Property '{id}' must be an object"));
        };

        let key = match get(prop, "key").and_then(Yaml::as_str) {
            Some(key) if !key.trim().is_empty() => key.to_string(),
            _ => return err(format!("Property '{id}' must have a 'key' string")),
        };

        let type_str = get(prop, "type").and_then(Yaml::as_str).unwrap_or("");
        let Some(property_type) = property_type_from_str(type_str) else {
            return err(format!(
                "Property '{id}' has invalid type '{type_str}'. Valid: text, number, checkbox, date, select, multi_select, url"
            ));
        };

        let options = match get(prop, "options") {
            None | Some(Yaml::Null) => None,
            Some(Yaml::Sequence(items)) => {
                Some(items.iter().map(coerce_to_string).collect::<Vec<_>>())
            }
            Some(_) => return err(format!("Property '{id}' options must be an array")),
        };

        result.insert(
            id,
            CbaseProperty {
                key,
                label: get(prop, "label")
                    .filter(|v| !v.is_null())
                    .map(coerce_to_string),
                property_type,
                required: get(prop, "required")
                    .filter(|v| !v.is_null())
                    .map(coerce_to_bool),
                default: get(prop, "default").map(yaml_to_json),
                options,
            },
        );
    }

    Ok(result)
}

fn parse_filters(
    raw: &Yaml,
    path: &str,
    properties: &IndexMap<String, CbaseProperty>,
) -> ParseResult<Vec<CbaseFilter>> {
    let Yaml::Sequence(items) = raw else {
        return err(format!("'{path}' must be an array"));
    };
    items
        .iter()
        .enumerate()
        .map(|(i, item)| parse_filter(item, &format!("{path}[{i}]"), properties))
        .collect()
}

fn parse_filter(
    raw: &Yaml,
    path: &str,
    properties: &IndexMap<String, CbaseProperty>,
) -> ParseResult<CbaseFilter> {
    let Yaml::Mapping(map) = raw else {
        return err(format!("Filter at '{path}' must be an object"));
    };

    if get(map, "and").is_some() {
        return Ok(CbaseFilter::And {
            and: parse_filters(get(map, "and").unwrap(), &format!("{path}.and"), properties)?,
        });
    }
    if get(map, "or").is_some() {
        return Ok(CbaseFilter::Or {
            or: parse_filters(get(map, "or").unwrap(), &format!("{path}.or"), properties)?,
        });
    }
    if get(map, "not").is_some() {
        return Ok(CbaseFilter::Not {
            not: Box::new(parse_filter(
                get(map, "not").unwrap(),
                &format!("{path}.not"),
                properties,
            )?),
        });
    }

    let property = match get(map, "property").and_then(Yaml::as_str) {
        Some(property) => property.to_string(),
        None => return err(format!("Filter at '{path}' must have a 'property' string")),
    };
    if !properties.contains_key(&property) {
        return err(format!(
            "Filter at '{path}' references unknown property '{property}'"
        ));
    }
    let op_str = get(map, "op").and_then(Yaml::as_str).unwrap_or("");
    let Some(op) = operator_from_str(op_str) else {
        return err(format!(
            "Filter at '{path}' has invalid operator '{op_str}'"
        ));
    };

    Ok(CbaseFilter::Condition(CbaseFilterCondition {
        property,
        op,
        value: get(map, "value").map(yaml_to_json),
    }))
}

fn parse_sort_list(
    raw: &Yaml,
    path: &str,
    properties: &IndexMap<String, CbaseProperty>,
) -> ParseResult<Vec<CbaseSort>> {
    let Yaml::Sequence(items) = raw else {
        return err(format!("'{path}' must be an array"));
    };
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let Yaml::Mapping(map) = item else {
                return err(format!("Sort at '{path}[{i}]' must be an object"));
            };
            let by = match get(map, "by").and_then(Yaml::as_str) {
                Some(by) => by.to_string(),
                None => return err(format!("Sort at '{path}[{i}]' must have a 'by' string")),
            };
            if !properties.contains_key(&by) {
                return err(format!(
                    "Sort at '{path}[{i}]' references unknown property '{by}'"
                ));
            }
            let dir_str = get(map, "dir").and_then(Yaml::as_str).unwrap_or("asc");
            let dir = match dir_str {
                "asc" => SortDirection::Asc,
                "desc" => SortDirection::Desc,
                _ => {
                    return err(format!(
                        "Sort at '{path}[{i}]' has invalid direction '{dir_str}'"
                    ))
                }
            };
            Ok(CbaseSort { by, dir })
        })
        .collect()
}

fn parse_views(
    raw: Option<&Yaml>,
    properties: &IndexMap<String, CbaseProperty>,
) -> ParseResult<Vec<CbaseView>> {
    let items = match raw {
        Some(Yaml::Sequence(items)) if !items.is_empty() => items,
        _ => return err("'views' must be a non-empty array"),
    };

    let mut views = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let Yaml::Mapping(map) = item else {
            return err(format!("View at index {i} must be an object"));
        };

        let id = match get(map, "id").and_then(Yaml::as_str) {
            Some(id) if !id.trim().is_empty() => id.to_string(),
            _ => return err(format!("View at index {i} must have an 'id' string")),
        };
        let name = match get(map, "name").and_then(Yaml::as_str) {
            Some(name) if !name.trim().is_empty() => name.to_string(),
            _ => return err(format!("View at index {i} must have a 'name' string")),
        };
        if get(map, "type").and_then(Yaml::as_str) != Some("table") {
            return err(format!(
                "View '{id}' has unsupported type '{}'. Currently only 'table' is supported",
                display_opt(get(map, "type"))
            ));
        }

        let filters = match get(map, "filters") {
            Some(value) if !value.is_null() => Some(parse_filters(
                value,
                &format!("views[{i}].filters"),
                properties,
            )?),
            _ => None,
        };
        let sort = match get(map, "sort") {
            Some(value) if !value.is_null() => Some(parse_sort_list(
                value,
                &format!("views[{i}].sort"),
                properties,
            )?),
            _ => None,
        };
        let limit = match get(map, "limit") {
            None | Some(Yaml::Null) => None,
            Some(value) => match value.as_i64() {
                Some(limit) if limit >= 1 => Some(limit),
                _ => return err(format!("View '{id}' limit must be a positive number")),
            },
        };

        let table = match get(map, "table") {
            Some(value) if !value.is_null() => {
                parse_table_view(value, &format!("views[{i}].table"), properties)?
            }
            _ => CbaseTableView {
                columns: properties.keys().cloned().collect(),
                column_widths: None,
                row_height: None,
            },
        };

        views.push(CbaseView {
            id,
            name,
            view_type: "table".to_string(),
            default: get(map, "default")
                .filter(|v| !v.is_null())
                .map(coerce_to_bool),
            filters,
            sort,
            limit,
            table: Some(table),
        });
    }

    // Ensure exactly one default view.
    if !views.iter().any(|v| v.default == Some(true)) {
        if let Some(first) = views.first_mut() {
            first.default = Some(true);
        }
    }

    Ok(views)
}

fn parse_table_view(
    raw: &Yaml,
    path: &str,
    properties: &IndexMap<String, CbaseProperty>,
) -> ParseResult<CbaseTableView> {
    let Yaml::Mapping(map) = raw else {
        return err(format!("'{path}' must be an object"));
    };

    let columns = match get(map, "columns") {
        Some(Yaml::Sequence(items)) => items.iter().map(coerce_to_string).collect::<Vec<_>>(),
        _ => properties.keys().cloned().collect(),
    };
    for (i, column) in columns.iter().enumerate() {
        if !properties.contains_key(column) {
            return err(format!(
                "'{path}.columns[{i}]' references unknown property '{column}'"
            ));
        }
    }

    let column_widths = match get(map, "column_widths") {
        None | Some(Yaml::Null) => None,
        Some(Yaml::Mapping(widths)) => {
            let mut out = IndexMap::new();
            for (key, value) in widths {
                let key = key.as_str().unwrap_or_default().to_string();
                out.insert(key, value.as_f64().unwrap_or(200.0));
            }
            Some(out)
        }
        Some(_) => return err(format!("'{path}.column_widths' must be an object")),
    };

    let row_height = get(map, "row_height").and_then(Yaml::as_f64);

    Ok(CbaseTableView {
        columns,
        column_widths,
        row_height,
    })
}

fn parse_template(raw: &Yaml) -> ParseResult<CbaseTemplate> {
    let Yaml::Mapping(map) = raw else {
        return err("'template' must be an object");
    };

    let folder = match get(map, "folder").and_then(Yaml::as_str) {
        Some(folder) => folder.to_string(),
        None => return err("'template.folder' must be a string"),
    };
    let filename = match get(map, "filename").and_then(Yaml::as_str) {
        Some(filename) => filename.to_string(),
        None => return err("'template.filename' must be a string"),
    };

    let frontmatter = match get(map, "frontmatter") {
        Some(Yaml::Mapping(fm)) => {
            let mut out = IndexMap::new();
            for (key, value) in fm {
                let key = key.as_str().unwrap_or_default().to_string();
                out.insert(key, yaml_to_json(value));
            }
            Some(out)
        }
        _ => None,
    };
    let body = get(map, "body")
        .and_then(Yaml::as_str)
        .map(|s| s.to_string());

    Ok(CbaseTemplate {
        folder,
        filename,
        frontmatter,
        body,
    })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn get<'a>(map: &'a serde_yaml::Mapping, key: &str) -> Option<&'a Yaml> {
    map.get(Yaml::String(key.to_string()))
}

fn property_type_from_str(value: &str) -> Option<CbasePropertyType> {
    match value {
        "text" => Some(CbasePropertyType::Text),
        "number" => Some(CbasePropertyType::Number),
        "checkbox" => Some(CbasePropertyType::Checkbox),
        "date" => Some(CbasePropertyType::Date),
        "select" => Some(CbasePropertyType::Select),
        "multi_select" => Some(CbasePropertyType::MultiSelect),
        "url" => Some(CbasePropertyType::Url),
        _ => None,
    }
}

fn operator_from_str(value: &str) -> Option<FilterOperator> {
    match value {
        "=" => Some(FilterOperator::Eq),
        "!=" => Some(FilterOperator::Ne),
        "<" => Some(FilterOperator::Lt),
        ">" => Some(FilterOperator::Gt),
        "<=" => Some(FilterOperator::Le),
        ">=" => Some(FilterOperator::Ge),
        "contains" => Some(FilterOperator::Contains),
        "not_contains" => Some(FilterOperator::NotContains),
        "starts_with" => Some(FilterOperator::StartsWith),
        "ends_with" => Some(FilterOperator::EndsWith),
        "is_empty" => Some(FilterOperator::IsEmpty),
        "is_not_empty" => Some(FilterOperator::IsNotEmpty),
        _ => None,
    }
}

/// Coerce a scalar YAML value to a string, matching `String(value)`.
fn coerce_to_string(value: &Yaml) -> String {
    match value {
        Yaml::String(s) => s.clone(),
        Yaml::Bool(b) => b.to_string(),
        Yaml::Number(n) => n.to_string(),
        Yaml::Null => "null".to_string(),
        _ => "[object Object]".to_string(),
    }
}

fn coerce_to_bool(value: &Yaml) -> bool {
    match value {
        Yaml::Bool(b) => *b,
        Yaml::Null => false,
        Yaml::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Yaml::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn display_opt(value: Option<&Yaml>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Yaml::Null) => "null".to_string(),
        Some(other) => coerce_to_string(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_CBASE: &str = r#"
version: 1
name: Tasks
dataset:
  include:
    - "tasks/**/*.md"
properties:
  p_title:
    key: title
    type: text
views:
  - id: v_table
    name: Table
    type: table
"#;

    fn parse(content: &str) -> Result<CbaseDefinition, String> {
        parse_cbase(content, None).map_err(|e| e.to_string())
    }

    #[test]
    fn parses_minimal_valid_cbase() {
        let result = parse(MINIMAL_CBASE).unwrap();
        assert_eq!(result.version, 1);
        assert_eq!(result.name, "Tasks");
        assert_eq!(result.dataset.include, vec!["tasks/**/*.md".to_string()]);
        assert_eq!(result.properties["p_title"].key, "title");
        assert_eq!(
            result.properties["p_title"].property_type,
            CbasePropertyType::Text
        );
        assert_eq!(result.views.len(), 1);
        assert_eq!(result.views[0].id, "v_table");
        assert_eq!(result.views[0].default, Some(true));
    }

    #[test]
    fn parses_full_cbase_with_all_features() {
        let yaml = r##"
version: 1
name: Project Tasks
description: All project tasks
dataset:
  include:
    - "tasks/**/*.md"
    - "issues/**/*.md"
  exclude:
    - "templates/**"
properties:
  p_title:
    key: title
    type: text
    required: true
  p_status:
    key: status
    type: select
    options: [todo, doing, done]
    default: todo
  p_priority:
    key: priority
    type: number
  p_done:
    key: done
    type: checkbox
  p_tags:
    key: tags
    type: multi_select
filters:
  - property: p_status
    op: "!="
    value: cancelled
sort:
  - by: p_priority
    dir: desc
views:
  - id: v_all
    name: All Tasks
    type: table
    default: true
    table:
      columns: [p_title, p_status, p_priority, p_done, p_tags]
      column_widths:
        p_title: 300
        p_status: 120
  - id: v_active
    name: Active
    type: table
    filters:
      - property: p_done
        op: "="
        value: false
    sort:
      - by: p_priority
        dir: asc
    limit: 50
template:
  folder: "tasks/"
  filename: "{{date:YYYY-MM-DD}}-{{slug(p_title)}}.md"
  frontmatter:
    status: todo
    done: false
  body: "# New Task\n"
"##;
        let result = parse(yaml).unwrap();
        assert_eq!(result.name, "Project Tasks");
        assert_eq!(result.description.as_deref(), Some("All project tasks"));
        assert_eq!(result.dataset.include.len(), 2);
        assert_eq!(
            result.dataset.exclude,
            Some(vec!["templates/**".to_string()])
        );
        assert_eq!(result.properties.len(), 5);
        assert_eq!(result.filters.as_ref().map(|f| f.len()), Some(1));
        assert_eq!(result.sort.as_ref().map(|s| s.len()), Some(1));
        assert_eq!(result.views.len(), 2);
        assert_eq!(result.views[0].default, Some(true));
        assert_eq!(result.views[1].limit, Some(50));
        assert_eq!(
            result.template.as_ref().map(|t| t.folder.as_str()),
            Some("tasks/")
        );
        assert_eq!(
            result.template.as_ref().map(|t| t.filename.as_str()),
            Some("{{date:YYYY-MM-DD}}-{{slug(p_title)}}.md")
        );
    }

    #[test]
    fn rejects_invalid_yaml() {
        assert!(parse("{{invalid").is_err());
    }

    #[test]
    fn rejects_missing_version() {
        assert!(parse("name: Test").unwrap_err().contains("version"));
    }

    #[test]
    fn rejects_unsupported_version() {
        assert!(parse("version: 2\nname: Test")
            .unwrap_err()
            .contains("version"));
    }

    #[test]
    fn rejects_missing_name() {
        assert!(parse("version: 1\ndataset:\n  include: ['*']")
            .unwrap_err()
            .contains("name"));
    }

    #[test]
    fn rejects_missing_dataset() {
        assert!(parse("version: 1\nname: T\nproperties: {}\nviews: []")
            .unwrap_err()
            .contains("dataset"));
    }

    #[test]
    fn rejects_empty_include() {
        let yaml = r#"
version: 1
name: T
dataset:
  include: []
properties:
  p: { key: k, type: text }
views:
  - id: v
    name: V
    type: table
"#;
        assert!(parse(yaml).unwrap_err().contains("include"));
    }

    #[test]
    fn rejects_invalid_property_type() {
        let yaml = r#"
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p:
    key: k
    type: invalid_type
views:
  - id: v
    name: V
    type: table
"#;
        assert!(parse(yaml).unwrap_err().contains("invalid_type"));
    }

    #[test]
    fn rejects_unsupported_view_type() {
        let yaml = r#"
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p:
    key: k
    type: text
views:
  - id: v
    name: V
    type: board
"#;
        assert!(parse(yaml).unwrap_err().contains("board"));
    }

    #[test]
    fn parses_compound_filters() {
        let yaml = r#"
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_a: { key: a, type: text }
  p_b: { key: b, type: number }
filters:
  - and:
    - property: p_a
      op: "!="
      value: ""
    - or:
      - property: p_b
        op: ">"
        value: 0
      - property: p_b
        op: is_empty
views:
  - id: v
    name: V
    type: table
"#;
        let result = parse(yaml).unwrap();
        let filters = result.filters.unwrap();
        assert_eq!(filters.len(), 1);
        assert!(matches!(filters[0], CbaseFilter::And { .. }));
    }

    #[test]
    fn rejects_filters_referencing_unknown_properties() {
        let yaml = r#"
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_title: { key: title, type: text }
filters:
  - property: p_missing
    op: "="
    value: test
views:
  - id: v
    name: V
    type: table
"#;
        assert!(parse(yaml).unwrap_err().contains("unknown property"));
    }

    #[test]
    fn rejects_sort_referencing_unknown_properties() {
        let yaml = r#"
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_title: { key: title, type: text }
sort:
  - by: p_missing
    dir: asc
views:
  - id: v
    name: V
    type: table
"#;
        assert!(parse(yaml).unwrap_err().contains("unknown property"));
    }

    #[test]
    fn rejects_table_columns_referencing_unknown_properties() {
        let yaml = r#"
version: 1
name: T
dataset:
  include: ["*.md"]
properties:
  p_title: { key: title, type: text }
views:
  - id: v
    name: V
    type: table
    table:
      columns: [p_title, p_missing]
"#;
        assert!(parse(yaml).unwrap_err().contains("unknown property"));
    }

    #[test]
    fn auto_generates_table_columns_from_properties() {
        let result = parse(MINIMAL_CBASE).unwrap();
        assert_eq!(
            result.views[0].table.as_ref().map(|t| t.columns.clone()),
            Some(vec!["p_title".to_string()])
        );
    }
}
