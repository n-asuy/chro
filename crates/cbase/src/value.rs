//! Dynamic value helpers operating on JSON values.
//!
//! Row property values and filter operands are dynamically typed (string,
//! number, boolean, array, null). These helpers mirror the coercion and
//! comparison semantics used when filtering and sorting rows.

use std::cmp::Ordering;

use serde_json::Value as JsonValue;

/// A value is "empty" when it is null/absent, a blank string, or an empty array.
pub fn is_empty(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => true,
        JsonValue::String(s) => s.trim().is_empty(),
        JsonValue::Array(items) => items.is_empty(),
        _ => false,
    }
}

/// Coerce a value to a comparable number, matching loose numeric coercion:
/// numbers as-is, booleans as 1/0, numeric strings parsed, everything else 0.
fn to_comparable_number(value: &JsonValue) -> f64 {
    match value {
        JsonValue::Number(n) => n.as_f64().unwrap_or(0.0),
        JsonValue::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        JsonValue::String(s) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Coerce a scalar value to its display string, matching `String(value)`.
/// Arrays are joined with ", "; null becomes an empty string.
pub fn to_display_string(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Array(items) => items
            .iter()
            .map(scalar_to_string)
            .collect::<Vec<_>>()
            .join(", "),
        JsonValue::Object(_) => "[object Object]".to_string(),
    }
}

/// Coerce an individual (non-array) item to a string for `contains`/joins.
fn scalar_to_string(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::String(s) => s.clone(),
        JsonValue::Bool(b) => b.to_string(),
        JsonValue::Number(n) => n.to_string(),
        JsonValue::Array(_) | JsonValue::Object(_) => to_display_string(value),
    }
}

/// The string used as the left-hand operand of `contains`/`starts_with`/`ends_with`.
pub fn search_string(value: &JsonValue) -> String {
    scalar_to_string(value)
}

/// True when `value` (or any of its array items) contains `needle` (case-insensitive).
pub fn contains_value(value: &JsonValue, needle: &str) -> bool {
    let needle = needle.to_lowercase();
    match value {
        JsonValue::Array(items) => items
            .iter()
            .any(|item| scalar_to_string(item).to_lowercase().contains(&needle)),
        _ => search_string(value).to_lowercase().contains(&needle),
    }
}

/// Three-way comparison with empty values ordered first.
pub fn compare(a: &JsonValue, b: &JsonValue) -> Ordering {
    let (a_empty, b_empty) = (is_empty(a), is_empty(b));
    if a_empty && b_empty {
        return Ordering::Equal;
    }
    if a_empty {
        return Ordering::Less;
    }
    if b_empty {
        return Ordering::Greater;
    }

    let a_num = matches!(a, JsonValue::Number(_));
    let b_num = matches!(b, JsonValue::Number(_));
    if a_num && b_num {
        return cmp_f64(to_comparable_number(a), to_comparable_number(b));
    }
    if a_num || b_num {
        return cmp_f64(to_comparable_number(a), to_comparable_number(b));
    }

    if let (JsonValue::Bool(a_bool), JsonValue::Bool(b_bool)) = (a, b) {
        return (*a_bool as i32).cmp(&(*b_bool as i32));
    }

    to_display_string(a).cmp(&to_display_string(b))
}

fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_empty_values() {
        assert!(is_empty(&JsonValue::Null));
        assert!(is_empty(&json!("")));
        assert!(is_empty(&json!("   ")));
        assert!(is_empty(&json!([])));
        assert!(!is_empty(&json!("x")));
        assert!(!is_empty(&json!(0)));
        assert!(!is_empty(&json!(false)));
    }

    #[test]
    fn compares_with_empty_first() {
        assert_eq!(compare(&JsonValue::Null, &json!("a")), Ordering::Less);
        assert_eq!(compare(&json!(2), &json!(1)), Ordering::Greater);
        assert_eq!(compare(&json!("a"), &json!("b")), Ordering::Less);
    }

    #[test]
    fn contains_checks_array_items() {
        assert!(contains_value(&json!(["urgent", "frontend"]), "urgent"));
        assert!(!contains_value(&json!(["urgent", "frontend"]), "backend"));
        assert!(contains_value(&json!("Test Task"), "test"));
    }

    #[test]
    fn display_string_joins_arrays() {
        assert_eq!(to_display_string(&json!(["a", "b"])), "a, b");
        assert_eq!(to_display_string(&json!(2)), "2");
        assert_eq!(to_display_string(&json!(false)), "false");
        assert_eq!(to_display_string(&JsonValue::Null), "");
    }
}
