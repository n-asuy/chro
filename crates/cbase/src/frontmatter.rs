//! YAML frontmatter extraction.
//!
//! Reads the leading `---` fenced YAML block from a markdown document and
//! normalizes its top-level entries into dynamic JSON values: scalars stay
//! scalar, sequences collapse to string arrays, and anything richer degrades to
//! its string form. A document without a valid frontmatter block yields no
//! properties.

use std::sync::OnceLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::Value as JsonValue;

fn frontmatter_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---(?:\r?\n|$)").unwrap())
}

/// Extract and normalize the frontmatter properties from markdown content.
pub fn extract_properties(content: &str) -> IndexMap<String, JsonValue> {
    let mut out = IndexMap::new();
    let Some(captures) = frontmatter_regex().captures(content) else {
        return out;
    };
    let raw_yaml = captures.get(1).map(|m| m.as_str()).unwrap_or("");

    let Ok(serde_yaml::Value::Mapping(mapping)) =
        serde_yaml::from_str::<serde_yaml::Value>(raw_yaml)
    else {
        return out;
    };

    for (key, value) in mapping {
        let Some(key) = key.as_str() else { continue };
        out.insert(key.to_string(), normalize_value(&value));
    }
    out
}

/// Normalize a parsed YAML value to a supported dynamic value, matching the
/// frontend's frontmatter coercion (arrays become string arrays).
fn normalize_value(value: &serde_yaml::Value) -> JsonValue {
    match value {
        serde_yaml::Value::Null => JsonValue::Null,
        serde_yaml::Value::Bool(b) => JsonValue::Bool(*b),
        serde_yaml::Value::Number(n) => number_to_json(n),
        serde_yaml::Value::String(s) => JsonValue::String(s.clone()),
        serde_yaml::Value::Sequence(items) => JsonValue::Array(
            items
                .iter()
                .map(|item| JsonValue::String(scalar_to_string(item)))
                .collect(),
        ),
        // Mappings and tagged values degrade to their string representation,
        // mirroring `String(value)` on a non-array object.
        _ => JsonValue::String("[object Object]".to_string()),
    }
}

fn number_to_json(n: &serde_yaml::Number) -> JsonValue {
    if let Some(i) = n.as_i64() {
        return JsonValue::Number(i.into());
    }
    if let Some(u) = n.as_u64() {
        return JsonValue::Number(u.into());
    }
    if let Some(f) = n.as_f64() {
        if let Some(num) = serde_json::Number::from_f64(f) {
            return JsonValue::Number(num);
        }
    }
    JsonValue::Null
}

fn scalar_to_string(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Bool(b) => b.to_string(),
        serde_yaml::Value::Number(n) => n.to_string(),
        serde_yaml::Value::Null => "null".to_string(),
        _ => "[object Object]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn returns_empty_without_frontmatter() {
        assert!(extract_properties("# Just a heading\n").is_empty());
    }

    #[test]
    fn extracts_scalar_and_sequence_values() {
        let content = "---\ntitle: Alpha Skill\ntags:\n  - work\n  - writing\npriority: 2\ndone: false\n---\nBody";
        let props = extract_properties(content);
        assert_eq!(props.get("title"), Some(&json!("Alpha Skill")));
        assert_eq!(props.get("tags"), Some(&json!(["work", "writing"])));
        assert_eq!(props.get("priority"), Some(&json!(2)));
        assert_eq!(props.get("done"), Some(&json!(false)));
    }

    #[test]
    fn keeps_iso_dates_as_strings() {
        let props = extract_properties("---\ndue: 2025-01-10\n---\n");
        assert_eq!(props.get("due"), Some(&json!("2025-01-10")));
    }

    #[test]
    fn handles_trailing_frontmatter_without_body() {
        let props = extract_properties("---\ntitle: latest\n---\n");
        assert_eq!(props.get("title"), Some(&json!("latest")));
    }
}
