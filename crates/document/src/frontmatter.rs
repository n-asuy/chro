//! YAML frontmatter reading, shared by every consumer of markdown metadata.
//!
//! Reads the leading `---` fenced YAML block from a markdown document and
//! normalizes its top-level entries into dynamic JSON values: scalars stay
//! scalar, sequences collapse to string arrays, and anything richer degrades to
//! its string form. A document without a valid frontmatter block yields no
//! properties.
//!
//! This crate owns *reading*. Rewriting a property is the view engine's job
//! (it needs that crate's error type and YAML coercion), and builds on
//! [`split`] and [`parse_mapping`] here so both directions agree on what
//! counts as a frontmatter block.

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::OnceLock;

use indexmap::IndexMap;
use regex::Regex;
use serde_json::Value as JsonValue;

/// Top-level frontmatter entries, in document order.
pub type Properties = IndexMap<String, JsonValue>;

/// Upper bound on a frontmatter block when streaming it off disk. Real blocks
/// are a few hundred bytes; the cap only stops a pathological file that opens
/// with `---` and never closes it from being read into memory.
const MAX_FRONTMATTER_BYTES: usize = 1 << 20;

fn frontmatter_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)^---\r?\n(.*?)\r?\n---(?:\r?\n|$)").unwrap())
}

/// Split a document into its raw frontmatter YAML and the body that follows.
/// Returns `None` when the document has no valid leading block, in which case
/// the whole document is body.
pub fn split(content: &str) -> Option<(&str, &str)> {
    let matched = frontmatter_regex().find(content)?;
    let raw_yaml = frontmatter_regex()
        .captures(content)
        .and_then(|captures| captures.get(1))
        .map(|group| group.as_str())
        .unwrap_or("");
    Some((raw_yaml, &content[matched.end()..]))
}

/// Parse raw frontmatter YAML into a mapping. `None` when the block is not a
/// YAML mapping (a sequence or a scalar), which callers treat as invalid
/// frontmatter rather than as an empty one.
pub fn parse_mapping(raw_yaml: &str) -> Option<serde_yaml::Mapping> {
    if raw_yaml.trim().is_empty() {
        return Some(serde_yaml::Mapping::new());
    }
    match serde_yaml::from_str::<serde_yaml::Value>(raw_yaml) {
        Ok(serde_yaml::Value::Mapping(mapping)) => Some(mapping),
        _ => None,
    }
}

/// Extract and normalize the frontmatter properties from markdown content.
pub fn extract_properties(content: &str) -> Properties {
    let Some((raw_yaml, _body)) = split(content) else {
        return Properties::new();
    };
    parse_properties(raw_yaml)
}

/// Read a file's frontmatter properties without loading its body.
///
/// Indexing only needs the leading `---` block, so reading the whole document
/// (often orders of magnitude larger) just to throw the body away dominates
/// index time on big notes. This streams lines until the closing delimiter and
/// stops. Returns the same properties [`extract_properties`] would, and an
/// empty map for documents without a valid frontmatter block.
pub fn read_file_properties(path: &Path) -> std::io::Result<Properties> {
    let mut reader = BufReader::new(File::open(path)?);

    let mut opening = String::new();
    if reader.read_line(&mut opening)? == 0 {
        return Ok(Properties::new());
    }
    // The opening delimiter must be the very first line, and (matching the
    // regex) must be terminated by a newline.
    if !opening.ends_with('\n') || trim_line_end(&opening) != "---" {
        return Ok(Properties::new());
    }

    let mut raw_yaml = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            // No closing delimiter: not a frontmatter block.
            return Ok(Properties::new());
        }
        if trim_line_end(&line) == "---" {
            break;
        }
        raw_yaml.push_str(&line);
        if raw_yaml.len() > MAX_FRONTMATTER_BYTES {
            return Ok(Properties::new());
        }
    }

    Ok(parse_properties(trim_line_end(&raw_yaml)))
}

/// Every name a document can be referenced by besides its filename: the
/// `aliases` (or `alias`) entry, which may be a scalar or a sequence.
///
/// This is the vocabulary a wikilink or a quick-open query is allowed to use,
/// so it deliberately excludes `title` — a title is prose about the document,
/// while an alias is an assertion that the document answers to that name.
pub fn aliases(properties: &Properties) -> Vec<String> {
    ["aliases", "alias"]
        .iter()
        .filter_map(|key| properties.get(*key))
        .flat_map(|value| match value {
            JsonValue::Array(items) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>(),
            JsonValue::String(single) => vec![single.clone()],
            _ => Vec::new(),
        })
        .map(|alias| alias.trim().to_string())
        .filter(|alias| !alias.is_empty())
        .collect()
}

fn trim_line_end(line: &str) -> &str {
    line.trim_end_matches('\n').trim_end_matches('\r')
}

/// Normalize a parsed YAML mapping into the dynamic property map.
fn parse_properties(raw_yaml: &str) -> Properties {
    let mut out = Properties::new();
    let Some(mapping) = parse_mapping(raw_yaml) else {
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

    #[test]
    fn splits_frontmatter_from_body() {
        let (raw, body) = split("---\ntitle: A\n---\nBody line\n").unwrap();
        assert_eq!(raw, "title: A");
        assert_eq!(body, "Body line\n");
        assert!(split("no frontmatter\n").is_none());
    }

    #[test]
    fn parse_mapping_rejects_non_mapping_blocks() {
        assert!(parse_mapping("- not\n- a\n- mapping\n").is_none());
        assert!(parse_mapping("").unwrap().is_empty());
    }

    #[test]
    fn aliases_accept_sequence_scalar_and_the_singular_key() {
        let sequence = extract_properties("---\naliases:\n  - Alpha\n  - A1\n---\n");
        assert_eq!(aliases(&sequence), vec!["Alpha", "A1"]);

        let scalar = extract_properties("---\naliases: Alpha\n---\n");
        assert_eq!(aliases(&scalar), vec!["Alpha"]);

        let singular = extract_properties("---\nalias: Alpha\n---\n");
        assert_eq!(aliases(&singular), vec!["Alpha"]);
    }

    #[test]
    fn aliases_ignore_blank_entries_and_absent_keys() {
        let blank = extract_properties("---\naliases:\n  - \"  \"\n  - Real\n---\n");
        assert_eq!(aliases(&blank), vec!["Real"]);
        // A title is prose about the document, not a name it answers to.
        let titled = extract_properties("---\ntitle: Alpha\n---\n");
        assert!(aliases(&titled).is_empty());
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
}
