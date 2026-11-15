//! Folding of superseded conversation-entry updates.
//!
//! Normalizers describe a conversation as a stream of whole-entry patches: a
//! streaming entry (command output, assistant text) is re-sent in full on every
//! delta. Anything that *keeps* those patches (a historic replay, a running
//! run's history, a batch about to be sent) pays `O(n²)` bytes for an entry
//! updated `n` times: one command that streamed 10 000 deltas into 3.8 MB of
//! output produced 17.7 GB of patches and drove the server past 30 GB.
//!
//! [`PatchFolder`] decides when a single-op `replace` of an entry can instead
//! overwrite the value of the previous `add`/`replace` of that same entry, so a
//! keeper holds roughly the current conversation, not its edit history.
//! [`ReplayLog`] is the keeper for replays and batches.
//!
//! The fold is exact under both ways patches are consumed: the desktop client
//! (entries keyed by path, upsert/delete) and the operator API (RFC 6902 array
//! semantics, where `remove` and inserting `add` shift indices). Anything that
//! could shift indices, i.e. a `remove`, an `add` at or below an index already
//! seen, or a multi-op/nested patch touching entries, is a barrier: patches
//! kept before it are never rewritten.

use std::collections::HashMap;

use serde_json::Value;

use crate::LogEntry;

const ENTRY_PATH_PREFIX: &str = "/entries/";

/// What a keeper should do with an incoming patch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fold {
    /// Overwrite the value of the patch kept under this sequence number (see
    /// [`fold_value_into`]) and keep nothing new.
    Into(u64),
    /// Keep the patch under the sequence number it was offered with.
    Keep,
}

/// Tracks, per conversation entry, the kept patch a later replace can fold into.
///
/// Sequence numbers are the keeper's own, strictly increasing identities for
/// the patches it keeps, so a keeper that evicts old patches stays correct by
/// calling [`PatchFolder::forget_before`].
#[derive(Debug, Default)]
pub struct PatchFolder {
    /// Entry index -> sequence number of its latest kept upsert.
    latest_by_index: HashMap<usize, u64>,
    /// Highest entry index upserted since the last barrier. An `add` at or
    /// below it may insert (array semantics) and shift later entries.
    high_water: Option<usize>,
}

enum PatchShape {
    /// One `add` or `replace` of a whole conversation entry.
    Upsert { replace: bool, index: usize },
    /// Touches entries in a way that may shift indices.
    Barrier,
    /// Does not touch entries (e.g. approvals); irrelevant to folding.
    Unrelated,
}

fn patch_shape(patch: &Value) -> PatchShape {
    let Some(ops) = patch.as_array() else {
        return PatchShape::Unrelated;
    };
    let touches_entries = |op: &Value| {
        op.get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| path == "/entries" || path.starts_with(ENTRY_PATH_PREFIX))
    };
    if let [only] = ops.as_slice() {
        let index = only
            .get("path")
            .and_then(Value::as_str)
            .and_then(|path| path.strip_prefix(ENTRY_PATH_PREFIX))
            .filter(|segment| segment.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|segment| segment.parse::<usize>().ok());
        let op = only.get("op").and_then(Value::as_str);
        if let (Some(index), Some("add" | "replace"), true) =
            (index, op, only.get("value").is_some())
        {
            return PatchShape::Upsert {
                replace: op == Some("replace"),
                index,
            };
        }
    }
    if ops.iter().any(touches_entries) {
        PatchShape::Barrier
    } else {
        PatchShape::Unrelated
    }
}

impl PatchFolder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decide the fate of `patch`, offered for keeping under `seq`.
    pub fn fold(&mut self, patch: &Value, seq: u64) -> Fold {
        match patch_shape(patch) {
            PatchShape::Unrelated => {}
            PatchShape::Barrier => self.barrier(),
            PatchShape::Upsert {
                replace: true,
                index,
            } => {
                if let Some(&earlier) = self.latest_by_index.get(&index) {
                    return Fold::Into(earlier);
                }
                self.record(index, seq);
            }
            PatchShape::Upsert {
                replace: false,
                index,
            } => {
                if self.high_water.is_some_and(|high| index <= high) {
                    self.barrier();
                }
                self.record(index, seq);
            }
        }
        Fold::Keep
    }

    /// Patches kept under sequence numbers below `seq` are gone.
    pub fn forget_before(&mut self, seq: u64) {
        self.latest_by_index.retain(|_, kept| *kept >= seq);
    }

    fn record(&mut self, index: usize, seq: u64) {
        self.latest_by_index.insert(index, seq);
        self.high_water = Some(self.high_water.map_or(index, |high| high.max(index)));
    }

    fn barrier(&mut self) {
        self.latest_by_index.clear();
        self.high_water = None;
    }
}

/// Move the value of single-op patch `later` into the kept patch `earlier`.
/// The earlier patch keeps its op (an `add` stays an `add`) and position.
pub fn fold_value_into(earlier: &mut Value, mut later: Value) {
    let value = later
        .as_array_mut()
        .and_then(|ops| ops.first_mut())
        .and_then(|op| op.get_mut("value"))
        .map(Value::take);
    if let (Some(value), Some(op)) = (
        value,
        earlier.as_array_mut().and_then(|ops| ops.first_mut()),
    ) {
        op["value"] = value;
    }
}

/// Collects replay output (or a batch about to be sent), folding superseded
/// entry replacements as they arrive.
#[derive(Debug, Default)]
pub struct ReplayLog {
    entries: Vec<LogEntry>,
    folder: PatchFolder,
}

impl ReplayLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, entry: LogEntry) {
        if let LogEntry::JsonPatch(patch) = &entry
            && let Fold::Into(earlier) = self.folder.fold(patch, self.entries.len() as u64)
        {
            if let (LogEntry::JsonPatch(kept), LogEntry::JsonPatch(later)) =
                (&mut self.entries[earlier as usize], entry)
            {
                fold_value_into(kept, later);
            }
            return;
        }
        self.entries.push(entry);
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn into_entries(self) -> Vec<LogEntry> {
        self.entries
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn patch(op: &str, path: &str, content: &str) -> LogEntry {
        LogEntry::JsonPatch(json!([{ "op": op, "path": path, "value": { "content": content } }]))
    }

    fn remove(path: &str) -> LogEntry {
        LogEntry::JsonPatch(json!([{ "op": "remove", "path": path }]))
    }

    fn collect(entries: impl IntoIterator<Item = LogEntry>) -> Vec<LogEntry> {
        let mut log = ReplayLog::new();
        entries.into_iter().for_each(|entry| log.push(entry));
        log.into_entries()
    }

    /// Fold patches with RFC 6902 array semantics (the operator API's model).
    fn fold_array(entries: &[LogEntry]) -> Value {
        let mut doc = json!({ "entries": [] });
        for entry in entries {
            if let LogEntry::JsonPatch(value) = entry {
                let patch: json_patch::Patch = serde_json::from_value(value.clone()).unwrap();
                json_patch::patch(&mut doc, &patch).unwrap();
            }
        }
        doc
    }

    /// Fold patches as the desktop client does: entries keyed by path, add and
    /// replace upsert, remove deletes.
    fn fold_keyed(entries: &[LogEntry]) -> Vec<(String, Value)> {
        let mut doc: Vec<(String, Value)> = Vec::new();
        for entry in entries {
            let LogEntry::JsonPatch(Value::Array(ops)) = entry else {
                continue;
            };
            for op in ops {
                let path = op["path"].as_str().unwrap().to_owned();
                let is_entry = path
                    .strip_prefix(ENTRY_PATH_PREFIX)
                    .is_some_and(|segment| segment.bytes().all(|byte| byte.is_ascii_digit()));
                if !is_entry {
                    continue; // the client ignores anything but /entries/<n>
                }
                let position = doc.iter().position(|(key, _)| *key == path);
                match (op["op"].as_str().unwrap(), position) {
                    ("remove", Some(at)) => {
                        doc.remove(at);
                    }
                    ("remove", None) => {}
                    (_, Some(at)) => doc[at].1 = op["value"].clone(),
                    (_, None) => doc.push((path, op["value"].clone())),
                }
            }
        }
        doc.sort_by(|a, b| a.0.cmp(&b.0));
        doc
    }

    fn assert_equivalent(input: Vec<LogEntry>) -> Vec<LogEntry> {
        let folded = collect(input.clone());
        assert_eq!(fold_array(&folded), fold_array(&input), "array semantics");
        assert_eq!(fold_keyed(&folded), fold_keyed(&input), "keyed semantics");
        folded
    }

    #[test]
    fn streaming_replaces_fold_into_the_entry_add() {
        let mut input = vec![patch("add", "/entries/0", "")];
        let mut output = String::new();
        for chunk in 0..1000 {
            output.push_str(&format!("line {chunk}\n"));
            input.push(patch("replace", "/entries/0", &output));
        }

        let folded = assert_equivalent(input);

        assert_eq!(folded, vec![patch("add", "/entries/0", &output)]);
    }

    #[test]
    fn interleaved_entries_fold_independently() {
        let folded = assert_equivalent(vec![
            patch("add", "/entries/0", "a"),
            patch("add", "/entries/1", "b"),
            patch("replace", "/entries/0", "a2"),
            patch("replace", "/entries/1", "b2"),
            patch("replace", "/entries/0", "a3"),
        ]);

        assert_eq!(
            folded,
            vec![
                patch("add", "/entries/0", "a3"),
                patch("add", "/entries/1", "b2")
            ]
        );
    }

    #[test]
    fn remove_is_a_barrier() {
        let folded = assert_equivalent(vec![
            patch("add", "/entries/0", "a"),
            patch("add", "/entries/1", "b"),
            remove("/entries/0"),
            patch("replace", "/entries/0", "b2"),
        ]);

        assert_eq!(folded.len(), 4, "nothing folds across a remove");
    }

    #[test]
    fn add_to_a_seen_path_is_a_barrier() {
        assert_equivalent(vec![
            patch("add", "/entries/0", "a"),
            patch("add", "/entries/0", "inserted"),
            patch("replace", "/entries/1", "a2"),
            patch("replace", "/entries/0", "inserted2"),
        ]);
    }

    #[test]
    fn add_below_a_seen_index_is_a_barrier() {
        assert_equivalent(vec![
            patch("add", "/entries/0", "a"),
            patch("add", "/entries/1", "b"),
            patch("add", "/entries/0", "inserted"),
            patch("replace", "/entries/1", "a2"),
        ]);
        assert_equivalent(vec![
            patch("add", "/entries/0", "a"),
            patch("add", "/entries/1", "b"),
            patch("add", "/entries/2", "c"),
            patch("add", "/entries/1", "inserted"),
            patch("replace", "/entries/2", "b2"),
        ]);
    }

    #[test]
    fn non_index_entry_paths_are_barriers() {
        let nested = LogEntry::JsonPatch(json!([
            { "op": "replace", "path": "/entries/0/content", "value": "x" }
        ]));
        let folded = assert_equivalent(vec![
            patch("add", "/entries/0", "a"),
            nested,
            patch("replace", "/entries/0", "a2"),
        ]);

        assert_eq!(folded.len(), 3);
    }

    #[test]
    fn multi_op_entry_patch_is_a_barrier() {
        let multi = LogEntry::JsonPatch(json!([
            { "op": "add", "path": "/entries/1", "value": { "content": "b" } },
            { "op": "remove", "path": "/entries/0" },
        ]));
        let folded = assert_equivalent(vec![
            patch("add", "/entries/0", "a"),
            multi,
            patch("replace", "/entries/0", "b2"),
        ]);

        assert_eq!(folded.len(), 3);
    }

    #[test]
    fn non_entry_patches_and_markers_pass_through_without_blocking_folds() {
        let approval =
            LogEntry::JsonPatch(json!([{ "op": "add", "path": "/approvals/x", "value": {} }]));
        let folded = collect(vec![
            patch("add", "/entries/0", "a"),
            LogEntry::SessionId("s".into()),
            approval.clone(),
            patch("replace", "/entries/0", "a2"),
            LogEntry::Finished,
        ]);

        assert_eq!(
            folded,
            vec![
                patch("add", "/entries/0", "a2"),
                LogEntry::SessionId("s".into()),
                approval,
                LogEntry::Finished,
            ]
        );
    }

    #[test]
    fn folder_stops_folding_into_forgotten_patches() {
        let mut folder = PatchFolder::new();
        let add = json!([{ "op": "add", "path": "/entries/0", "value": {} }]);
        let replace = json!([{ "op": "replace", "path": "/entries/0", "value": {} }]);

        assert_eq!(folder.fold(&add, 10), Fold::Keep);
        assert_eq!(folder.fold(&replace, 11), Fold::Into(10));
        folder.forget_before(11);
        assert_eq!(folder.fold(&replace, 11), Fold::Keep, "the add is gone");
        assert_eq!(folder.fold(&replace, 12), Fold::Into(11));
    }

    #[test]
    fn replace_without_a_prior_upsert_is_kept() {
        let folded = collect(vec![patch("replace", "/entries/3", "x")]);

        assert_eq!(folded, vec![patch("replace", "/entries/3", "x")]);
    }
}
