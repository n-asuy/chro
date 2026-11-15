use std::{collections::VecDeque, sync::RwLock};

use futures::{stream::BoxStream, StreamExt};
use json_patch::Patch;
use log_types::{fold_value_into, Fold, LogEntry, LogEntryPusher, PatchFolder};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

const HISTORY_BYTES: usize = 32 * 1024 * 1024;

struct StoredEntry {
    /// Contiguous within `history`: the front's seq plus its position.
    seq: u64,
    entry: LogEntry,
    bytes: usize,
}

struct Inner {
    history: VecDeque<StoredEntry>,
    total_bytes: usize,
    next_seq: u64,
    /// Folds a streaming entry's updates into its kept patch, so history holds
    /// the current conversation rather than every intermediate version of it.
    folder: PatchFolder,
}

impl Inner {
    fn position(&self, seq: u64) -> Option<usize> {
        let front = self.history.front()?.seq;
        let position = usize::try_from(seq.checked_sub(front)?).ok()?;
        (position < self.history.len()).then_some(position)
    }

    fn evict_to(&mut self, budget: usize) {
        while self.total_bytes > budget {
            let Some(front) = self.history.pop_front() else {
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(front.bytes);
            self.folder.forget_before(front.seq + 1);
        }
    }
}

/// In-memory log buffer that keeps a bounded history and broadcasts live messages.
///
/// Live subscribers receive every entry as pushed. History (what a late
/// subscriber or reader starts from) folds superseded entry updates, see
/// [`log_types::PatchFolder`].
pub struct MsgStore {
    inner: RwLock<Inner>,
    sender: broadcast::Sender<LogEntry>,
}

impl MsgStore {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(1024);
        Self {
            inner: RwLock::new(Inner {
                history: VecDeque::with_capacity(128),
                total_bytes: 0,
                next_seq: 0,
                folder: PatchFolder::new(),
            }),
            sender,
        }
    }

    pub fn push(&self, entry: LogEntry) {
        let _ = self.sender.send(entry.clone());
        let bytes = entry.approx_bytes();
        if bytes > HISTORY_BYTES {
            // The live subscriber still receives the entry, but one anomalous
            // payload must not make the bounded history exceed its contract.
            return;
        }
        let mut inner = self.inner.write().expect("msg store poisoned");
        let seq = inner.next_seq;

        if let LogEntry::JsonPatch(patch) = &entry {
            if let Fold::Into(earlier) = inner.folder.fold(patch, seq) {
                if let Some(position) = inner.position(earlier) {
                    let LogEntry::JsonPatch(later) = entry else {
                        unreachable!("matched above");
                    };
                    let kept = &mut inner.history[position];
                    let previous_bytes = std::mem::replace(&mut kept.bytes, bytes);
                    if let LogEntry::JsonPatch(kept_patch) = &mut kept.entry {
                        fold_value_into(kept_patch, later);
                    }
                    inner.total_bytes = inner.total_bytes - previous_bytes + bytes;
                    inner.evict_to(HISTORY_BYTES);
                    return;
                }
            }
        }

        inner.evict_to(HISTORY_BYTES - bytes);
        inner.total_bytes += bytes;
        inner.next_seq += 1;
        inner.history.push_back(StoredEntry { seq, entry, bytes });
    }

    /// Deliver `entry` to live subscribers without retaining it. For feeds
    /// whose late subscribers rebuild their state elsewhere, such as database
    /// changes (each data stream snapshots from the database), where keeping
    /// history would cost a serialization per write and memory nobody reads.
    pub fn broadcast(&self, entry: LogEntry) {
        let _ = self.sender.send(entry);
    }

    pub fn push_patch(&self, patch: Patch) {
        self.push(LogEntry::from(patch));
    }

    pub fn push_session_id<S: Into<String>>(&self, data: S) {
        self.push(LogEntry::SessionId(data.into()));
    }

    pub fn history(&self) -> Vec<LogEntry> {
        self.inner
            .read()
            .expect("msg store poisoned")
            .history
            .iter()
            .map(|stored| stored.entry.clone())
            .collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.sender.subscribe()
    }

    pub fn history_plus_stream(&self) -> BoxStream<'static, LogEntry> {
        let history = self.history();
        let hist_stream = futures::stream::iter(history);
        let live_stream =
            BroadcastStream::new(self.subscribe()).filter_map(|item| async { item.ok() });
        Box::pin(hist_stream.chain(live_stream))
    }
}

impl Default for MsgStore {
    fn default() -> Self {
        Self::new()
    }
}

impl LogEntryPusher for MsgStore {
    fn push(&self, entry: LogEntry) {
        MsgStore::push(self, entry);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_and_history() {
        let store = MsgStore::new();
        store.push(LogEntry::Stdout("hello".into()));
        store.push(LogEntry::Stderr("err".into()));
        let history = store.history();
        assert_eq!(history.len(), 2);
    }

    fn entry_patch(op: &str, index: usize, content: &str) -> LogEntry {
        LogEntry::JsonPatch(serde_json::json!([{
            "op": op,
            "path": format!("/entries/{index}"),
            "value": { "content": content },
        }]))
    }

    #[test]
    fn history_folds_streaming_updates_while_subscribers_see_each() {
        let store = MsgStore::new();
        let mut subscriber = store.subscribe();
        store.push(LogEntry::Stdout("raw".into()));
        store.push(entry_patch("add", 0, ""));
        let mut output = String::new();
        for chunk in 0..1_000 {
            output.push_str(&format!("{chunk}\n"));
            store.push(entry_patch("replace", 0, &output));
        }

        assert_eq!(
            store.history(),
            vec![
                LogEntry::Stdout("raw".into()),
                entry_patch("add", 0, &output)
            ]
        );
        let mut received = 0;
        while subscriber.try_recv().is_ok() {
            received += 1;
        }
        assert_eq!(received, 1_002);
    }

    #[test]
    fn history_bytes_track_the_folded_size() {
        let store = MsgStore::new();
        store.push(entry_patch("add", 0, &"x".repeat(1_000)));
        store.push(entry_patch("replace", 0, "short"));

        // Approximate: the folded patch is costed as the update that replaced
        // its value, not as the 1 000-byte original.
        let inner = store.inner.read().unwrap();
        assert_eq!(
            inner.total_bytes,
            entry_patch("replace", 0, "short").approx_bytes()
        );
    }

    #[test]
    fn update_of_an_evicted_entry_is_kept_as_its_own_patch() {
        let store = MsgStore::new();
        let big = "x".repeat(HISTORY_BYTES / 2);
        store.push(entry_patch("add", 0, "a"));
        store.push(entry_patch("add", 1, &big));
        store.push(entry_patch("add", 2, &big)); // evicts entries 0 and 1
        store.push(entry_patch("replace", 0, "a2"));
        store.push(entry_patch("replace", 0, "a3"));

        assert_eq!(
            store.history(),
            vec![entry_patch("add", 2, &big), entry_patch("replace", 0, "a3")]
        );
    }

    #[test]
    fn broadcast_reaches_subscribers_without_entering_history() {
        let store = MsgStore::new();
        let mut subscriber = store.subscribe();

        store.broadcast(entry_patch("add", 0, "a"));

        assert!(store.history().is_empty());
        assert_eq!(subscriber.try_recv().unwrap(), entry_patch("add", 0, "a"));
    }

    #[test]
    fn oversized_entry_is_broadcast_but_not_retained() {
        let store = MsgStore::new();
        let mut subscriber = store.subscribe();
        store.push(LogEntry::Stdout("x".repeat(HISTORY_BYTES + 1)));
        assert!(store.history().is_empty());
        assert!(matches!(
            subscriber.try_recv(),
            Ok(LogEntry::Stdout(value)) if value.len() == HISTORY_BYTES + 1
        ));
    }
}
