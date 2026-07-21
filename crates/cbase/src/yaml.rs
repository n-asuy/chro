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

/// Convert a JSON value into its YAML equivalent (inverse of [`yaml_to_json`]).
pub fn json_to_yaml(value: &JsonValue) -> serde_yaml::Value {
    match value {
        JsonValue::Null => serde_yaml::Value::Null,
        JsonValue::Bool(b) => serde_yaml::Value::Bool(*b),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                serde_yaml::Value::Number(i.into())
            } else if let Some(u) = n.as_u64() {
                serde_yaml::Value::Number(u.into())
            } else {
                n.as_f64()
                    .map(|f| serde_yaml::Value::Number(f.into()))
                    .unwrap_or(serde_yaml::Value::Null)
            }
        }
        JsonValue::String(s) => serde_yaml::Value::String(s.clone()),
        JsonValue::Array(items) => {
            serde_yaml::Value::Sequence(items.iter().map(json_to_yaml).collect())
        }
        JsonValue::Object(map) => {
            let mut mapping = serde_yaml::Mapping::new();
            for (key, val) in map {
                mapping.insert(
                    serde_yaml::Value::String(key.clone()),
                    json_to_yaml(val),
                );
            }
            serde_yaml::Value::Mapping(mapping)
        }
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
