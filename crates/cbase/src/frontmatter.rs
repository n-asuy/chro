//! Frontmatter rewriting.
//!
//! Reading is owned by the shared `document` crate; this module adds the
//! write direction, which needs this crate's error type and YAML coercion. It
//! builds on the shared [`document::frontmatter::split`] / [`document::frontmatter::parse_mapping`]
//! so both directions agree on what counts as a frontmatter block.

use serde_json::Value as JsonValue;

use crate::error::CbaseError;

/// Rewrite one top-level frontmatter property, preserving every other key
/// (in order) and the document body byte-for-byte. A JSON `null` removes the
/// key; removing the last key drops the frontmatter block entirely. A document
/// without frontmatter gains a new block. YAML comments inside the block are
/// not preserved (the block is re-serialized), matching how reference
/// implementations rewrite frontmatter programmatically.
pub fn set_property(content: &str, key: &str, value: &JsonValue) -> Result<String, CbaseError> {
    let (mut mapping, body) = match document::frontmatter::split(content) {
        Some((raw_yaml, body)) => {
            let parsed = document::frontmatter::parse_mapping(raw_yaml).ok_or_else(|| {
                CbaseError::Parse("frontmatter is not a valid YAML mapping".to_string())
            })?;
            (parsed, body)
        }
        None => (serde_yaml::Mapping::new(), content),
    };

    let yaml_key = serde_yaml::Value::String(key.to_string());
    if value.is_null() {
        // Rebuild instead of `Mapping::remove`, which may not preserve the
        // order of the remaining keys.
        mapping = mapping
            .into_iter()
            .filter(|(existing, _)| existing != &yaml_key)
            .collect();
    } else {
        mapping.insert(yaml_key, crate::yaml::json_to_yaml(value));
    }

    if mapping.is_empty() {
        return Ok(body.to_string());
    }

    let yaml = serde_yaml::to_string(&mapping)
        .map_err(|e| CbaseError::Parse(format!("Failed to serialize frontmatter: {e}")))?;
    Ok(format!("---\n{yaml}---\n{body}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use document::frontmatter::extract_properties;
    use serde_json::json;

    #[test]
    fn set_property_updates_value_preserving_order_and_body() {
        let content = "---\ntitle: Alpha\nstatus: todo\ntags:\n  - work\n---\nBody line\n\n## Heading\n";
        let updated = set_property(content, "status", &json!("doing")).unwrap();
        assert!(updated.ends_with("---\nBody line\n\n## Heading\n"));
        let props = extract_properties(&updated);
        assert_eq!(
            props.keys().collect::<Vec<_>>(),
            vec!["title", "status", "tags"],
            "key order must be preserved"
        );
        assert_eq!(props.get("status"), Some(&json!("doing")));
        assert_eq!(props.get("tags"), Some(&json!(["work"])));
    }

    #[test]
    fn set_property_adds_key_and_creates_block_when_missing() {
        let updated = set_property("Just a body\n", "done", &json!(true)).unwrap();
        assert!(updated.starts_with("---\n"));
        assert!(updated.ends_with("Just a body\n"));
        assert_eq!(extract_properties(&updated).get("done"), Some(&json!(true)));

        let with_new_key = set_property("---\ntitle: A\n---\n", "priority", &json!(2)).unwrap();
        let props = extract_properties(&with_new_key);
        assert_eq!(props.get("priority"), Some(&json!(2)));
        assert_eq!(props.get("title"), Some(&json!("A")));
    }

    #[test]
    fn set_property_null_removes_key_and_empty_block() {
        let updated =
            set_property("---\ntitle: A\ndone: true\n---\nBody\n", "done", &json!(null)).unwrap();
        let props = extract_properties(&updated);
        assert!(!props.contains_key("done"));
        assert_eq!(props.get("title"), Some(&json!("A")));

        let emptied = set_property("---\ntitle: A\n---\nBody\n", "title", &json!(null)).unwrap();
        assert_eq!(emptied, "Body\n", "removing the last key drops the block");
    }

    #[test]
    fn set_property_handles_arrays_and_rejects_invalid_frontmatter() {
        let updated =
            set_property("---\ntitle: A\n---\n", "tags", &json!(["work", "urgent"])).unwrap();
        assert_eq!(
            extract_properties(&updated).get("tags"),
            Some(&json!(["work", "urgent"]))
        );

        assert!(set_property("---\n- not\n- a\n- mapping\n---\n", "k", &json!(1)).is_err());
    }
}
