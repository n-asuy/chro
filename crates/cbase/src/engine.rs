//! Filter and sort engine.
//!
//! Evaluates filter trees against indexed rows and produces sorted, limited
//! view results. Global filters/sort combine with per-view filters/sort exactly
//! as the on-disk schema specifies.

use std::cmp::Ordering;

use indexmap::IndexMap;
use serde_json::Value as JsonValue;

use crate::types::{
    CbaseFilter, CbaseFilterCondition, CbaseProperty, CbaseRow, CbaseSort, CbaseView,
    CbaseViewResult, FilterOperator, SortDirection,
};
use crate::value::{compare, contains_value, is_empty, search_string};

/// Aggregate row payload guard for one interactive page. The HTTP envelope adds
/// a little overhead, but bounding serialized rows prevents a handful of very
/// large frontmatter blocks from defeating the row-count page limit.
const MAX_VIEW_PAGE_ROW_BYTES: usize = 8 * 1024 * 1024;

/// Resolve a property's value for a row, including `file.*` built-ins.
pub fn resolve_property_value(
    row: &CbaseRow,
    property_id: &str,
    properties: &IndexMap<String, CbaseProperty>,
) -> JsonValue {
    let Some(property) = properties.get(property_id) else {
        return JsonValue::Null;
    };

    match property.key.as_str() {
        "file.path" => JsonValue::String(row.file_path.clone()),
        "file.name" => JsonValue::String(row.display_name.clone()),
        "file.folder" => {
            let normalized = row.file_path.replace('\\', "/");
            let folder = match normalized.rfind('/') {
                Some(index) => normalized[..index].to_string(),
                None => String::new(),
            };
            JsonValue::String(folder)
        }
        "file.mtime" | "file.modified" | "file.modifiedAt" => row
            .modified_at
            .clone()
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
        "file.ext" => {
            let normalized = row.file_path.replace('\\', "/");
            let ext = match normalized.rfind('.') {
                Some(index) => normalized[index + 1..].to_string(),
                None => String::new(),
            };
            JsonValue::String(ext)
        }
        key => row.values.get(key).cloned().unwrap_or(JsonValue::Null),
    }
}

fn evaluate_condition(
    row: &CbaseRow,
    condition: &CbaseFilterCondition,
    properties: &IndexMap<String, CbaseProperty>,
) -> bool {
    let value = resolve_property_value(row, &condition.property, properties);
    let target = condition.value.clone().unwrap_or(JsonValue::Null);

    match condition.op {
        FilterOperator::IsEmpty => is_empty(&value),
        FilterOperator::IsNotEmpty => !is_empty(&value),
        FilterOperator::Eq => compare(&value, &target) == Ordering::Equal,
        FilterOperator::Ne => compare(&value, &target) != Ordering::Equal,
        FilterOperator::Lt => compare(&value, &target) == Ordering::Less,
        FilterOperator::Gt => compare(&value, &target) == Ordering::Greater,
        FilterOperator::Le => matches!(compare(&value, &target), Ordering::Less | Ordering::Equal),
        FilterOperator::Ge => {
            matches!(
                compare(&value, &target),
                Ordering::Greater | Ordering::Equal
            )
        }
        FilterOperator::Contains => contains_value(&value, &search_string(&target)),
        FilterOperator::NotContains => !contains_value(&value, &search_string(&target)),
        FilterOperator::StartsWith => search_string(&value)
            .to_lowercase()
            .starts_with(&search_string(&target).to_lowercase()),
        FilterOperator::EndsWith => search_string(&value)
            .to_lowercase()
            .ends_with(&search_string(&target).to_lowercase()),
    }
}

/// Evaluate a filter tree against a row.
pub fn evaluate_filter(
    row: &CbaseRow,
    filter: &CbaseFilter,
    properties: &IndexMap<String, CbaseProperty>,
) -> bool {
    match filter {
        CbaseFilter::And { and } => and.iter().all(|f| evaluate_filter(row, f, properties)),
        CbaseFilter::Or { or } => or.iter().any(|f| evaluate_filter(row, f, properties)),
        CbaseFilter::Not { not } => !evaluate_filter(row, not, properties),
        CbaseFilter::Condition(condition) => evaluate_condition(row, condition, properties),
    }
}

/// Keep rows that satisfy every filter (filters AND-combine).
pub fn filter_rows(
    rows: Vec<CbaseRow>,
    filters: &[CbaseFilter],
    properties: &IndexMap<String, CbaseProperty>,
) -> Vec<CbaseRow> {
    if filters.is_empty() {
        return rows;
    }
    rows.into_iter()
        .filter(|row| {
            filters
                .iter()
                .all(|filter| evaluate_filter(row, filter, properties))
        })
        .collect()
}

/// Sort rows by the given keys, breaking ties on file path.
pub fn sort_rows(
    mut rows: Vec<CbaseRow>,
    sort_specs: &[CbaseSort],
    properties: &IndexMap<String, CbaseProperty>,
) -> Vec<CbaseRow> {
    if sort_specs.is_empty() {
        return rows;
    }
    rows.sort_by(|a, b| {
        for spec in sort_specs {
            let a_val = resolve_property_value(a, &spec.by, properties);
            let b_val = resolve_property_value(b, &spec.by, properties);
            let ordering = compare(&a_val, &b_val);
            if ordering != Ordering::Equal {
                return match spec.dir {
                    SortDirection::Desc => ordering.reverse(),
                    SortDirection::Asc => ordering,
                };
            }
        }
        a.file_path.cmp(&b.file_path)
    });
    rows
}

/// Execute a view: apply global filters, view filters, sort, and limit.
pub fn execute_view(
    rows: &[CbaseRow],
    view: &CbaseView,
    properties: &IndexMap<String, CbaseProperty>,
    global_filters: Option<&[CbaseFilter]>,
    global_sort: Option<&[CbaseSort]>,
) -> CbaseViewResult {
    let mut result = rows.to_vec();
    let mut total_count = result.len() as i64;

    if let Some(filters) = global_filters.filter(|f| !f.is_empty()) {
        result = filter_rows(result, filters, properties);
        total_count = result.len() as i64;
    }
    if let Some(filters) = view.filters.as_deref().filter(|f| !f.is_empty()) {
        result = filter_rows(result, filters, properties);
        total_count = result.len() as i64;
    }

    let view_sort = view.sort.as_deref().filter(|s| !s.is_empty());
    let sort = view_sort.or_else(|| global_sort.filter(|s| !s.is_empty()));
    if let Some(sort) = sort {
        result = sort_rows(result, sort, properties);
    }

    if let Some(limit) = view.limit.filter(|&l| l > 0) {
        total_count = result.len() as i64;
        result.truncate(limit as usize);
    }

    CbaseViewResult {
        view: view.clone(),
        rows: result,
        total_count,
        page_offset: 0,
        has_more: false,
    }
}

/// Execute one bounded page while keeping source rows borrowed until the final
/// page is known. This avoids cloning every indexed row merely to discard most
/// of them at the response boundary.
pub(crate) fn execute_view_page(
    rows: &[CbaseRow],
    view: &CbaseView,
    properties: &IndexMap<String, CbaseProperty>,
    global_filters: Option<&[CbaseFilter]>,
    global_sort: Option<&[CbaseSort]>,
    offset: usize,
    limit: usize,
) -> CbaseViewResult {
    let mut result: Vec<&CbaseRow> = rows
        .iter()
        .filter(|row| {
            global_filters
                .filter(|filters| !filters.is_empty())
                .is_none_or(|filters| {
                    filters
                        .iter()
                        .all(|filter| evaluate_filter(row, filter, properties))
                })
        })
        .filter(|row| {
            view.filters
                .as_deref()
                .filter(|filters| !filters.is_empty())
                .is_none_or(|filters| {
                    filters
                        .iter()
                        .all(|filter| evaluate_filter(row, filter, properties))
                })
        })
        .collect();
    let total_count = result.len() as i64;

    let view_sort = view.sort.as_deref().filter(|sort| !sort.is_empty());
    let sort = view_sort.or_else(|| global_sort.filter(|sort| !sort.is_empty()));
    if let Some(sort_specs) = sort {
        result.sort_by(|a, b| {
            for spec in sort_specs {
                let a_val = resolve_property_value(a, &spec.by, properties);
                let b_val = resolve_property_value(b, &spec.by, properties);
                let ordering = compare(&a_val, &b_val);
                if ordering != Ordering::Equal {
                    return match spec.dir {
                        SortDirection::Desc => ordering.reverse(),
                        SortDirection::Asc => ordering,
                    };
                }
            }
            a.file_path.cmp(&b.file_path)
        });
    }

    let available = view
        .limit
        .filter(|limit| *limit > 0)
        .map_or(result.len(), |view_limit| {
            result.len().min(view_limit as usize)
        });
    let start = offset.min(available);
    let requested_end = start.saturating_add(limit.max(1)).min(available);
    let mut rows = Vec::with_capacity(requested_end.saturating_sub(start));
    let mut row_bytes = 0usize;
    let mut end = start;
    while end < requested_end {
        let row = result[end];
        let estimated = serde_json::to_vec(row).map_or(0, |encoded| encoded.len());
        if !rows.is_empty() && row_bytes.saturating_add(estimated) > MAX_VIEW_PAGE_ROW_BYTES {
            break;
        }
        row_bytes = row_bytes.saturating_add(estimated);
        rows.push((*row).clone());
        end += 1;
    }

    CbaseViewResult {
        view: view.clone(),
        rows,
        total_count,
        page_offset: start as i64,
        has_more: end < available,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CbaseProperty, CbasePropertyType, CbaseTableView};
    use serde_json::json;

    fn prop(key: &str, ty: CbasePropertyType) -> CbaseProperty {
        CbaseProperty::new(key, ty)
    }

    fn properties() -> IndexMap<String, CbaseProperty> {
        use CbasePropertyType::*;
        IndexMap::from_iter([
            ("p_title".to_string(), prop("title", Text)),
            ("p_status".to_string(), prop("status", Select)),
            ("p_priority".to_string(), prop("priority", Number)),
            ("p_done".to_string(), prop("done", Checkbox)),
            ("p_due".to_string(), prop("due", Date)),
            ("p_tags".to_string(), prop("tags", MultiSelect)),
            ("p_url".to_string(), prop("url", Url)),
            ("p_file_name".to_string(), prop("file.name", Text)),
            ("p_file_path".to_string(), prop("file.path", Text)),
            ("p_file_folder".to_string(), prop("file.folder", Text)),
            ("p_file_mtime".to_string(), prop("file.mtime", Date)),
        ])
    }

    fn row(file_path: &str, values: Vec<(&str, JsonValue)>) -> CbaseRow {
        let display_name = file_path
            .rsplit('/')
            .next()
            .unwrap_or(file_path)
            .trim_end_matches(".md")
            .to_string();
        CbaseRow {
            file_path: file_path.to_string(),
            display_name,
            modified_at: None,
            values: values
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        }
    }

    fn cond(property: &str, op: FilterOperator, value: Option<JsonValue>) -> CbaseFilter {
        CbaseFilter::Condition(CbaseFilterCondition {
            property: property.to_string(),
            op,
            value,
        })
    }

    fn test_row() -> CbaseRow {
        row(
            "test.md",
            vec![
                ("title", json!("Test Task")),
                ("status", json!("doing")),
                ("priority", json!(2)),
                ("done", json!(false)),
                ("due", json!("2026-03-01")),
                ("tags", json!(["urgent", "frontend"])),
                ("url", json!("https://example.com")),
            ],
        )
    }

    #[test]
    fn equality_operators() {
        let props = properties();
        let r = test_row();
        assert!(evaluate_filter(
            &r,
            &cond("p_status", FilterOperator::Eq, Some(json!("doing"))),
            &props
        ));
        assert!(!evaluate_filter(
            &r,
            &cond("p_status", FilterOperator::Eq, Some(json!("done"))),
            &props
        ));
        assert!(evaluate_filter(
            &r,
            &cond("p_status", FilterOperator::Ne, Some(json!("done"))),
            &props
        ));
    }

    #[test]
    fn comparison_operators() {
        let props = properties();
        let r = test_row();
        assert!(evaluate_filter(
            &r,
            &cond("p_priority", FilterOperator::Gt, Some(json!(1))),
            &props
        ));
        assert!(evaluate_filter(
            &r,
            &cond("p_priority", FilterOperator::Lt, Some(json!(5))),
            &props
        ));
        assert!(evaluate_filter(
            &r,
            &cond("p_priority", FilterOperator::Ge, Some(json!(2))),
            &props
        ));
        assert!(evaluate_filter(
            &r,
            &cond("p_priority", FilterOperator::Le, Some(json!(2))),
            &props
        ));
    }

    #[test]
    fn string_operators() {
        let props = properties();
        let r = test_row();
        assert!(evaluate_filter(
            &r,
            &cond("p_title", FilterOperator::Contains, Some(json!("Test"))),
            &props
        ));
        assert!(evaluate_filter(
            &r,
            &cond("p_title", FilterOperator::Contains, Some(json!("test"))),
            &props
        ));
        assert!(!evaluate_filter(
            &r,
            &cond("p_title", FilterOperator::NotContains, Some(json!("Test"))),
            &props
        ));
        assert!(evaluate_filter(
            &r,
            &cond("p_title", FilterOperator::StartsWith, Some(json!("Test"))),
            &props
        ));
        assert!(evaluate_filter(
            &r,
            &cond("p_title", FilterOperator::EndsWith, Some(json!("Task"))),
            &props
        ));
    }

    #[test]
    fn file_built_in_fields() {
        let props = properties();
        let file_row = row("tasks/Test Task.md", vec![("title", json!("Test Task"))]);
        assert!(evaluate_filter(
            &file_row,
            &cond("p_file_name", FilterOperator::Contains, Some(json!("Test"))),
            &props
        ));
        assert!(evaluate_filter(
            &file_row,
            &cond("p_file_folder", FilterOperator::Eq, Some(json!("tasks"))),
            &props
        ));
        assert!(evaluate_filter(
            &file_row,
            &cond(
                "p_file_path",
                FilterOperator::StartsWith,
                Some(json!("tasks/"))
            ),
            &props
        ));
    }

    #[test]
    fn empty_operators() {
        let props = properties();
        assert!(evaluate_filter(
            &row("test.md", vec![]),
            &cond("p_title", FilterOperator::IsEmpty, None),
            &props
        ));
        assert!(evaluate_filter(
            &test_row(),
            &cond("p_title", FilterOperator::IsNotEmpty, None),
            &props
        ));
        assert!(evaluate_filter(
            &row("test.md", vec![("tags", json!([]))]),
            &cond("p_tags", FilterOperator::IsEmpty, None),
            &props
        ));
    }

    #[test]
    fn multi_select_contains() {
        let props = properties();
        let r = test_row();
        assert!(evaluate_filter(
            &r,
            &cond("p_tags", FilterOperator::Contains, Some(json!("urgent"))),
            &props
        ));
        assert!(!evaluate_filter(
            &r,
            &cond("p_tags", FilterOperator::Contains, Some(json!("backend"))),
            &props
        ));
    }

    #[test]
    fn compound_filters() {
        let props = properties();
        let r = test_row();
        let and = CbaseFilter::And {
            and: vec![
                cond("p_status", FilterOperator::Eq, Some(json!("doing"))),
                cond("p_priority", FilterOperator::Gt, Some(json!(1))),
            ],
        };
        assert!(evaluate_filter(&r, &and, &props));

        let and_fail = CbaseFilter::And {
            and: vec![
                cond("p_status", FilterOperator::Eq, Some(json!("doing"))),
                cond("p_priority", FilterOperator::Gt, Some(json!(5))),
            ],
        };
        assert!(!evaluate_filter(&r, &and_fail, &props));

        let or = CbaseFilter::Or {
            or: vec![
                cond("p_status", FilterOperator::Eq, Some(json!("done"))),
                cond("p_priority", FilterOperator::Eq, Some(json!(2))),
            ],
        };
        assert!(evaluate_filter(&r, &or, &props));

        let not = CbaseFilter::Not {
            not: Box::new(cond("p_status", FilterOperator::Eq, Some(json!("done")))),
        };
        assert!(evaluate_filter(&r, &not, &props));

        let nested = CbaseFilter::And {
            and: vec![
                CbaseFilter::Or {
                    or: vec![
                        cond("p_status", FilterOperator::Eq, Some(json!("doing"))),
                        cond("p_status", FilterOperator::Eq, Some(json!("done"))),
                    ],
                },
                CbaseFilter::Not {
                    not: Box::new(cond("p_done", FilterOperator::Eq, Some(json!(true)))),
                },
            ],
        };
        assert!(evaluate_filter(&r, &nested, &props));
    }

    fn sort_rows_data() -> Vec<CbaseRow> {
        vec![
            row(
                "c.md",
                vec![("title", json!("Charlie")), ("priority", json!(3))],
            ),
            row(
                "a.md",
                vec![("title", json!("Alpha")), ("priority", json!(1))],
            ),
            row(
                "b.md",
                vec![("title", json!("Bravo")), ("priority", json!(2))],
            ),
        ]
    }

    #[test]
    fn sorts_ascending_and_descending_text() {
        let props = properties();
        let asc = sort_rows(
            sort_rows_data(),
            &[CbaseSort {
                by: "p_title".into(),
                dir: SortDirection::Asc,
            }],
            &props,
        );
        assert_eq!(
            asc.iter()
                .map(|r| r.values["title"].clone())
                .collect::<Vec<_>>(),
            vec![json!("Alpha"), json!("Bravo"), json!("Charlie")]
        );
        let desc = sort_rows(
            sort_rows_data(),
            &[CbaseSort {
                by: "p_title".into(),
                dir: SortDirection::Desc,
            }],
            &props,
        );
        assert_eq!(
            desc.iter()
                .map(|r| r.values["title"].clone())
                .collect::<Vec<_>>(),
            vec![json!("Charlie"), json!("Bravo"), json!("Alpha")]
        );
    }

    #[test]
    fn sorts_nulls_first_in_ascending() {
        let props = properties();
        let mut data = sort_rows_data();
        data.push(row("d.md", vec![("title", json!("Delta"))]));
        let sorted = sort_rows(
            data,
            &[CbaseSort {
                by: "p_priority".into(),
                dir: SortDirection::Asc,
            }],
            &props,
        );
        assert_eq!(sorted[0].file_path, "d.md");
    }

    #[test]
    fn multi_key_sort() {
        let props = properties();
        let data = vec![
            row(
                "1.md",
                vec![("status", json!("doing")), ("priority", json!(2))],
            ),
            row(
                "2.md",
                vec![("status", json!("done")), ("priority", json!(1))],
            ),
            row(
                "3.md",
                vec![("status", json!("doing")), ("priority", json!(1))],
            ),
        ];
        let sorted = sort_rows(
            data,
            &[
                CbaseSort {
                    by: "p_status".into(),
                    dir: SortDirection::Asc,
                },
                CbaseSort {
                    by: "p_priority".into(),
                    dir: SortDirection::Asc,
                },
            ],
            &props,
        );
        assert_eq!(
            sorted
                .iter()
                .map(|r| r.file_path.clone())
                .collect::<Vec<_>>(),
            vec!["3.md", "1.md", "2.md"]
        );
    }

    fn execute_data() -> Vec<CbaseRow> {
        vec![
            row(
                "1.md",
                vec![
                    ("title", json!("Task 1")),
                    ("status", json!("todo")),
                    ("priority", json!(3)),
                ],
            ),
            row(
                "2.md",
                vec![
                    ("title", json!("Task 2")),
                    ("status", json!("doing")),
                    ("priority", json!(1)),
                ],
            ),
            row(
                "3.md",
                vec![
                    ("title", json!("Task 3")),
                    ("status", json!("done")),
                    ("priority", json!(2)),
                ],
            ),
            row(
                "4.md",
                vec![
                    ("title", json!("Task 4")),
                    ("status", json!("doing")),
                    ("priority", json!(4)),
                ],
            ),
        ]
    }

    fn base_view() -> CbaseView {
        CbaseView {
            id: "v_table".into(),
            name: "Table".into(),
            view_type: "table".into(),
            default: None,
            filters: None,
            sort: None,
            limit: None,
            table: Some(CbaseTableView {
                columns: vec!["p_title".into(), "p_status".into(), "p_priority".into()],
                column_widths: None,
                row_height: None,
            }),
        }
    }

    #[test]
    fn execute_view_returns_all_rows_without_filters() {
        let props = properties();
        let result = execute_view(&execute_data(), &base_view(), &props, None, None);
        assert_eq!(result.rows.len(), 4);
        assert_eq!(result.total_count, 4);
    }

    #[test]
    fn execute_view_page_returns_only_the_requested_window() {
        let props = properties();
        let result = execute_view_page(&execute_data(), &base_view(), &props, None, None, 1, 2);
        assert_eq!(
            result
                .rows
                .iter()
                .map(|row| row.file_path.as_str())
                .collect::<Vec<_>>(),
            vec!["2.md", "3.md"]
        );
        assert_eq!(result.total_count, 4);
        assert_eq!(result.page_offset, 1);
        assert!(result.has_more);
    }

    #[test]
    fn execute_view_page_respects_the_definition_limit() {
        let props = properties();
        let mut view = base_view();
        view.limit = Some(2);
        let result = execute_view_page(&execute_data(), &view, &props, None, None, 1, 2);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].file_path, "2.md");
        assert_eq!(result.total_count, 4);
        assert!(!result.has_more);
    }

    #[test]
    fn execute_view_applies_view_filters() {
        let props = properties();
        let mut view = base_view();
        view.filters = Some(vec![cond(
            "p_status",
            FilterOperator::Eq,
            Some(json!("doing")),
        )]);
        let result = execute_view(&execute_data(), &view, &props, None, None);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.total_count, 2);
    }

    #[test]
    fn execute_view_applies_global_and_view_filters() {
        let props = properties();
        let mut view = base_view();
        view.filters = Some(vec![cond(
            "p_status",
            FilterOperator::Eq,
            Some(json!("doing")),
        )]);
        let global = vec![cond("p_priority", FilterOperator::Gt, Some(json!(2)))];
        let result = execute_view(&execute_data(), &view, &props, Some(&global), None);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0].file_path, "4.md");
    }

    #[test]
    fn execute_view_applies_sort() {
        let props = properties();
        let mut view = base_view();
        view.sort = Some(vec![CbaseSort {
            by: "p_priority".into(),
            dir: SortDirection::Asc,
        }]);
        let result = execute_view(&execute_data(), &view, &props, None, None);
        assert_eq!(
            result
                .rows
                .iter()
                .map(|r| r.values["priority"].clone())
                .collect::<Vec<_>>(),
            vec![json!(1), json!(2), json!(3), json!(4)]
        );
    }

    #[test]
    fn execute_view_applies_limit() {
        let props = properties();
        let mut view = base_view();
        view.sort = Some(vec![CbaseSort {
            by: "p_priority".into(),
            dir: SortDirection::Asc,
        }]);
        view.limit = Some(2);
        let result = execute_view(&execute_data(), &view, &props, None, None);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.total_count, 4);
    }
}
