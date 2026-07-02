//! YAML value helpers shared by the parser and serializer.

use serde_json::Value as JsonValue;

/// Convert a parsed YAML value into a structure-preserving JSON value.
///
/// Unlike frontmatter normalization (which collapses arrays to strings), this
/// keeps the original shape so filter operands, property defaults, and template
/// frontmatter survive a parse round-trip unchanged.
pub fn yaml_to_json(value: &serde_yaml::Value) -> JsonValue {
    match value {
        serde_yaml::Value::Null => JsonValue::Null,
        serde_yaml::Value::Bool(b) => JsonValue::Bool(*b),
        serde_yaml::Value::Number(n) => number_to_json(n),
        serde_yaml::Value::String(s) => JsonValue::String(s.clone()),
        serde_yaml::Value::Sequence(items) => {
            JsonValue::Array(items.iter().map(yaml_to_json).collect())
        }
        serde_yaml::Value::Mapping(map) => {
            let mut obj = serde_json::Map::new();
            for (key, val) in map {
                let key = key
                    .as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| display_scalar(key));
                obj.insert(key, yaml_to_json(val));
            }
            JsonValue::Object(obj)
        }
        serde_yaml::Value::Tagged(tagged) => yaml_to_json(&tagged.value),
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

fn display_scalar(value: &serde_yaml::Value) -> String {
    match value {
        serde_yaml::Value::String(s) => s.clone(),
        serde_yaml::Value::Bool(b) => b.to_string(),
        serde_yaml::Value::Number(n) => n.to_string(),
        serde_yaml::Value::Null => "null".to_string(),
        _ => String::new(),
    }
}
