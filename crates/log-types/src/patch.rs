//! JSON Patch helpers for conversation entries.
//!
use json_patch::Patch;
use serde::{Deserialize, Serialize};
use serde_json::{from_value, json, to_value};

use crate::NormalizedEntry;

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PatchOp {
    Add,
    Replace,
    Remove,
}

#[allow(clippy::large_enum_variant)]
#[derive(Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE", tag = "type", content = "content")]
pub enum PatchType {
    NormalizedEntry(NormalizedEntry),
}

#[derive(Serialize)]
struct PatchEntry {
    op: PatchOp,
    path: String,
    value: PatchType,
}

/// Escape a string for use in a JSON Pointer path segment.
pub fn escape_json_pointer_segment(s: &str) -> String {
    s.replace('~', "~0").replace('/', "~1")
}

/// Helper functions to create JSON patches for conversation entries.
pub struct ConversationPatch;

impl ConversationPatch {
    /// Create an ADD patch for a new normalized entry at the given index.
    pub fn add_normalized_entry(entry_index: usize, entry: NormalizedEntry) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOp::Add,
            path: format!("/entries/{entry_index}"),
            value: PatchType::NormalizedEntry(entry),
        };
        from_value(json!([patch_entry])).expect("valid patch")
    }

    /// Create a REPLACE patch for updating an existing entry.
    pub fn replace(entry_index: usize, entry: NormalizedEntry) -> Patch {
        let patch_entry = PatchEntry {
            op: PatchOp::Replace,
            path: format!("/entries/{entry_index}"),
            value: PatchType::NormalizedEntry(entry),
        };
        from_value(json!([patch_entry])).expect("valid patch")
    }

    /// Create a REMOVE patch for removing an entry.
    pub fn remove(entry_index: usize) -> Patch {
        from_value(json!([{
            "op": PatchOp::Remove,
            "path": format!("/entries/{entry_index}"),
        }]))
        .expect("valid patch")
    }

    /// Create a REMOVE patch for removing an entry by string index.
    pub fn remove_by_key(entry_index: String) -> Patch {
        from_value(json!([{
            "op": PatchOp::Remove,
            "path": format!("/entries/{entry_index}"),
        }]))
        .expect("valid patch")
    }
}

/// Extract the entry index and `NormalizedEntry` from a JsonPatch if it contains one.
pub fn extract_normalized_entry_from_patch(patch: &Patch) -> Option<(usize, NormalizedEntry)> {
    let value = to_value(patch).ok()?;
    let ops = value.as_array()?;
    ops.iter().rev().find_map(|op| {
        let path = op.get("path")?.as_str()?;
        let entry_index = path.strip_prefix("/entries/")?.parse::<usize>().ok()?;

        let value = op.get("value")?;
        (value.get("type")?.as_str()? == "NORMALIZED_ENTRY")
            .then(|| value.get("content"))
            .flatten()
            .and_then(|c| from_value::<NormalizedEntry>(c.clone()).ok())
            .map(|entry| (entry_index, entry))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NormalizedEntryType;

    #[test]
    fn test_add_normalized_entry() {
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::SystemMessage,
            content: "Hello".to_string(),
            metadata: None,
        };
        let patch = ConversationPatch::add_normalized_entry(0, entry.clone());
        assert_eq!(patch.0.len(), 1);

        let extracted = extract_normalized_entry_from_patch(&patch);
        assert!(extracted.is_some());
        let (idx, extracted_entry) = extracted.unwrap();
        assert_eq!(idx, 0);
        assert_eq!(extracted_entry.content, "Hello");
    }

    #[test]
    fn test_replace() {
        let entry = NormalizedEntry {
            timestamp: None,
            entry_type: NormalizedEntryType::AssistantMessage,
            content: "Updated".to_string(),
            metadata: None,
        };
        let patch = ConversationPatch::replace(5, entry);
        assert_eq!(patch.0.len(), 1);
    }

    #[test]
    fn test_remove() {
        let patch = ConversationPatch::remove(3);
        assert_eq!(patch.0.len(), 1);
    }
}
