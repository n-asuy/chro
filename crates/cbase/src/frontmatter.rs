//! YAML frontmatter extraction.
//!
//! Reads the leading `---` fenced YAML block from a markdown document and
//! normalizes its top-level entries into dynamic JSON values: scalars stay
//! scalar, sequences collapse to string arrays, and anything richer degrades to
//! its string form. A document without a valid frontmatter block yields no
//! properties.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::OnceLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::Value as JsonValue;

use crate::error::CbaseError;

/// Upper bound on a frontmatter block when streaming it off disk. Real blocks
/// are a few hundred bytes; the cap only stops a pathological file that opens
/// with `---` and never closes it from being read into memory.
const MAX_FRONTMATTER_BYTES: usize = 1 << 20;

fn frontmatter_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---(?:\r?\n|$)").unwrap())
}

/// Extract and normalize the frontmatter properties from markdown content.
pub fn extract_properties(content: &str) -> IndexMap<String, JsonValue> {
    let Some(captures) = frontmatter_regex().captures(content) else {
        return IndexMap::new();
    };
    parse_frontmatter_yaml(captures.get(1).map(|m| m.as_str()).unwrap_or(""))
}

/// Read a file's frontmatter properties without loading its body.
///
/// Indexing only needs the leading `---` block, so reading the whole document
/// (often orders of magnitude larger) just to throw the body away dominates
/// index time on big notes. This streams lines until the closing delimiter and
/// stops. Returns the same properties [`extract_properties`] would, and an
/// empty map for documents without a valid frontmatter block.
pub(crate) fn read_file_properties(path: &Path) -> std::io::Result<IndexMap<String, JsonValue>> {
    let mut reader = BufReader::new(File::open(path)?);

    let mut opening = String::new();
    if reader.read_line(&mut opening)? == 0 {
        return Ok(IndexMap::new());
    }
    // The opening delimiter must be the very first line, and (matching the
    // regex) must be terminated by a newline.
    if !opening.ends_with('\n') || trim_line_end(&opening) != "---" {
        return Ok(IndexMap::new());
    }

    let mut raw_yaml = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            // No closing delimiter: not a frontmatter block.
            return Ok(IndexMap::new());
        }
        if trim_line_end(&line) == "---" {
            break;
        }
        raw_yaml.push_str(&line);
        if raw_yaml.len() > MAX_FRONTMATTER_BYTES {
            return Ok(IndexMap::new());
        }
    }

    Ok(parse_frontmatter_yaml(trim_line_end(&raw_yaml)))
}

fn trim_line_end(line: &str) -> &str {
    line.trim_end_matches('\n').trim_end_matches('\r')
}

/// Normalize a parsed YAML mapping into the dynamic property map.
fn parse_frontmatter_yaml(raw_yaml: &str) -> IndexMap<String, JsonValue> {
    let mut out = IndexMap::new();
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

/// Rewrite one top-level frontmatter property, preserving every other key
/// (in order) and the document body byte-for-byte. A JSON `null` removes the
/// key; removing the last key drops the frontmatter block entirely. A document
/// without frontmatter gains a new block. YAML comments inside the block are
/// not preserved (the block is re-serialized), matching how reference
/// implementations rewrite frontmatter programmatically.
pub fn set_property(
    content: &str,
    key: &str,
    value: &JsonValue,
) -> Result<String, CbaseError> {
    let (mut mapping, body) = match frontmatter_regex().find(content) {
        Some(matched) => {
            let raw_yaml = frontmatter_regex()
                .captures(content)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("");
            let parsed = if raw_yaml.trim().is_empty() {
                serde_yaml::Mapping::new()
            } else {
                match serde_yaml::from_str::<serde_yaml::Value>(raw_yaml) {
                    Ok(serde_yaml::Value::Mapping(mapping)) => mapping,
                    Ok(_) | Err(_) => {
                        return Err(CbaseError::Parse(
                            "frontmatter is not a valid YAML mapping".to_string(),
                        ))
                    }
                }
            };
            (parsed, &content[matched.end()..])
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

        let with_new_key =
            set_property("---\ntitle: A\n---\n", "priority", &json!(2)).unwrap();
        let props = extract_properties(&with_new_key);
        assert_eq!(props.get("priority"), Some(&json!(2)));
        assert_eq!(props.get("title"), Some(&json!("A")));
    }

    #[test]
    fn set_property_null_removes_key_and_empty_block() {
        let updated =
            set_property("---\ntitle: A\ndone: true\n---\nBody\n", "done", &json!(null))
                .unwrap();
        let props = extract_properties(&updated);
        assert!(!props.contains_key("done"));
        assert_eq!(props.get("title"), Some(&json!("A")));

        let emptied = set_property("---\ntitle: A\n---\nBody\n", "title", &json!(null)).unwrap();
        assert_eq!(emptied, "Body\n", "removing the last key drops the block");
    }

    #[test]
    fn read_file_properties_matches_extract_and_ignores_the_body() {
        let dir = tempfile::tempdir().unwrap();
        // A large body must not affect the parsed properties (and is never read).
        let body = "lorem ipsum dolor sit amet\n".repeat(20_000);
        let path = dir.path().join("note.md");
        std::fs::write(
            &path,
            format!("---\ntitle: Big\ntags:\n  - work\npriority: 2\n---\n{body}"),
        )
        .unwrap();

        let from_file = read_file_properties(&path).unwrap();
        assert_eq!(from_file.get("title"), Some(&json!("Big")));
        assert_eq!(from_file.get("tags"), Some(&json!(["work"])));
        assert_eq!(from_file.get("priority"), Some(&json!(2)));
        // Identical to parsing the whole document.
        let whole = extract_properties(&std::fs::read_to_string(&path).unwrap());
        assert_eq!(from_file, whole);
    }

    #[test]
    fn read_file_properties_returns_empty_without_a_valid_block() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, content: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, content).unwrap();
            path
        };

        // No frontmatter at all.
        assert!(read_file_properties(&write("a.md", "# Heading\n"))
            .unwrap()
            .is_empty());
        // Opening delimiter never closed.
        assert!(read_file_properties(&write("b.md", "---\ntitle: X\nbody\n"))
            .unwrap()
            .is_empty());
        // Delimiter not on the first line.
        assert!(
            read_file_properties(&write("c.md", "\n---\ntitle: X\n---\n"))
                .unwrap()
                .is_empty()
        );
        // Empty file.
        assert!(read_file_properties(&write("d.md", "")).unwrap().is_empty());
    }

    #[test]
    fn set_property_handles_arrays_and_rejects_invalid_frontmatter() {
        let updated = set_property(
            "---\ntitle: A\n---\n",
            "tags",
            &json!(["work", "urgent"]),
        )
        .unwrap();
        assert_eq!(
            extract_properties(&updated).get("tags"),
            Some(&json!(["work", "urgent"]))
        );

        assert!(set_property("---\n- not\n- a\n- mapping\n---\n", "k", &json!(1)).is_err());
    }
}
