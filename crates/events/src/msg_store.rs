use std::{collections::VecDeque, sync::RwLock};

use futures::{stream::BoxStream, StreamExt};
use json_patch::Patch;
use log_types::{LogEntry, LogEntryPusher};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

const HISTORY_BYTES: usize = 100 * 1024 * 1024;

struct StoredEntry {
    entry: LogEntry,
    bytes: usize,
}

struct Inner {
    history: VecDeque<StoredEntry>,
    total_bytes: usize,
}

/// In-memory log buffer that keeps a bounded history and broadcasts live messages.
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
            }),
            sender,
        }
    }

    pub fn push(&self, entry: LogEntry) {
        let _ = self.sender.send(entry.clone());
        let bytes = entry.approx_bytes();
        let mut inner = self.inner.write().expect("msg store poisoned");
        while inner.total_bytes + bytes > HISTORY_BYTES {
            if let Some(front) = inner.history.pop_front() {
                inner.total_bytes = inner.total_bytes.saturating_sub(front.bytes);
            } else {
                break;
            }
        }
        inner.total_bytes = inner.total_bytes.saturating_add(bytes);
        inner.history.push_back(StoredEntry { entry, bytes });
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
}
