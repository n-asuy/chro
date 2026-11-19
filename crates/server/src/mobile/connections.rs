//! Who is connected to the phone listener, and the limits on it.
//!
//! Every count is held by a guard that releases it on drop, so a connection
//! task that ends any way (error, revoke, panic) gives its slots back.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Caps {
    /// Open TCP connections, including ones still in the WebSocket upgrade.
    pub tcp: usize,
    /// Open WebSockets.
    pub websockets: usize,
    /// Unauthenticated sockets per source (IPv4 host, IPv6 /64). Loopback
    /// and sources that already hold an authenticated socket are exempt.
    pub unauthenticated_per_source: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Self {
            tcp: 256,
            websockets: 128,
            unauthenticated_per_source: 64,
        }
    }
}

#[derive(Default)]
struct Counts {
    tcp: usize,
    websockets: usize,
    unauthenticated: HashMap<String, usize>,
    authenticated: HashMap<String, usize>,
    devices: HashMap<Uuid, Vec<(u64, CancellationToken)>>,
    next_connection: u64,
    /// Socket writer tasks still alive. A connection's writer must be gone
    /// once the connection is, or it keeps the socket open past every cap.
    writers: usize,
}

#[derive(Clone)]
pub(crate) struct ConnectionTable {
    caps: Caps,
    counts: Arc<Mutex<Counts>>,
}

impl ConnectionTable {
    pub(crate) fn new(caps: Caps) -> Self {
        Self {
            caps,
            counts: Arc::default(),
        }
    }

    pub(crate) fn try_tcp(&self) -> Option<TcpSlot> {
        let mut counts = self.counts.lock().unwrap();
        if counts.tcp >= self.caps.tcp {
            return None;
        }
        counts.tcp += 1;
        Some(TcpSlot {
            counts: Arc::clone(&self.counts),
        })
    }

    pub(crate) fn try_websocket(&self) -> Option<WebSocketSlot> {
        let mut counts = self.counts.lock().unwrap();
        if counts.websockets >= self.caps.websockets {
            return None;
        }
        counts.websockets += 1;
        Some(WebSocketSlot {
            counts: Arc::clone(&self.counts),
        })
    }

    pub(crate) fn try_unauthenticated(
        &self,
        source: &str,
        is_loopback: bool,
    ) -> Option<UnauthenticatedSlot> {
        let mut counts = self.counts.lock().unwrap();
        let exempt = is_loopback || counts.authenticated.get(source).copied().unwrap_or(0) > 0;
        let held = counts.unauthenticated.get(source).copied().unwrap_or(0);
        if !exempt && held >= self.caps.unauthenticated_per_source {
            return None;
        }
        *counts
            .unauthenticated
            .entry(source.to_string())
            .or_default() += 1;
        Some(UnauthenticatedSlot {
            counts: Arc::clone(&self.counts),
            source: source.to_string(),
        })
    }

    /// Register an authenticated connection. Its token is cancelled when the
    /// device is disconnected.
    pub(crate) fn authenticated(&self, device_id: Uuid, source: &str) -> AuthenticatedSlot {
        let mut counts = self.counts.lock().unwrap();
        *counts.authenticated.entry(source.to_string()).or_default() += 1;
        counts.next_connection += 1;
        let connection = counts.next_connection;
        let cancel = CancellationToken::new();
        counts
            .devices
            .entry(device_id)
            .or_default()
            .push((connection, cancel.clone()));
        AuthenticatedSlot {
            counts: Arc::clone(&self.counts),
            source: source.to_string(),
            device_id,
            connection,
            cancel,
        }
    }

    /// Held by a connection's socket writer task for as long as it runs.
    pub(crate) fn writer(&self) -> WriterSlot {
        self.counts.lock().unwrap().writers += 1;
        WriterSlot {
            counts: Arc::clone(&self.counts),
        }
    }

    #[cfg(test)]
    pub(crate) fn writers(&self) -> usize {
        self.counts.lock().unwrap().writers
    }

    /// Cut every connection of `device_id`. Returns how many there were.
    pub(crate) fn disconnect(&self, device_id: Uuid) -> usize {
        let counts = self.counts.lock().unwrap();
        let Some(connections) = counts.devices.get(&device_id) else {
            return 0;
        };
        for (_, cancel) in connections {
            cancel.cancel();
        }
        connections.len()
    }

    #[cfg(test)]
    pub(crate) fn connections_of(&self, device_id: Uuid) -> usize {
        self.counts
            .lock()
            .unwrap()
            .devices
            .get(&device_id)
            .map_or(0, Vec::len)
    }
}

pub(crate) struct TcpSlot {
    counts: Arc<Mutex<Counts>>,
}

impl Drop for TcpSlot {
    fn drop(&mut self) {
        self.counts.lock().unwrap().tcp -= 1;
    }
}

pub(crate) struct WebSocketSlot {
    counts: Arc<Mutex<Counts>>,
}

impl Drop for WebSocketSlot {
    fn drop(&mut self) {
        self.counts.lock().unwrap().websockets -= 1;
    }
}

pub(crate) struct WriterSlot {
    counts: Arc<Mutex<Counts>>,
}

impl Drop for WriterSlot {
    fn drop(&mut self) {
        self.counts.lock().unwrap().writers -= 1;
    }
}

pub(crate) struct UnauthenticatedSlot {
    counts: Arc<Mutex<Counts>>,
    source: String,
}

impl Drop for UnauthenticatedSlot {
    fn drop(&mut self) {
        decrement(
            &mut self.counts.lock().unwrap().unauthenticated,
            &self.source,
        );
    }
}

pub(crate) struct AuthenticatedSlot {
    counts: Arc<Mutex<Counts>>,
    source: String,
    device_id: Uuid,
    connection: u64,
    cancel: CancellationToken,
}

impl AuthenticatedSlot {
    /// Cancelled when the device is revoked.
    pub(crate) fn cancelled(&self) -> CancellationToken {
        self.cancel.clone()
    }
}

impl Drop for AuthenticatedSlot {
    fn drop(&mut self) {
        let mut counts = self.counts.lock().unwrap();
        decrement(&mut counts.authenticated, &self.source);
        if let Some(connections) = counts.devices.get_mut(&self.device_id) {
            connections.retain(|(connection, _)| *connection != self.connection);
            if connections.is_empty() {
                counts.devices.remove(&self.device_id);
            }
        }
    }
}

fn decrement(map: &mut HashMap<String, usize>, key: &str) {
    if let Some(count) = map.get_mut(key) {
        *count -= 1;
        if *count == 0 {
            map.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> ConnectionTable {
        ConnectionTable::new(Caps {
            tcp: 2,
            websockets: 1,
            unauthenticated_per_source: 2,
        })
    }

    #[test]
    fn tcp_and_websocket_caps_release_on_drop() {
        let table = table();
        let a = table.try_tcp().unwrap();
        let _b = table.try_tcp().unwrap();
        assert!(table.try_tcp().is_none());
        drop(a);
        assert!(table.try_tcp().is_some());

        let ws = table.try_websocket().unwrap();
        assert!(table.try_websocket().is_none());
        drop(ws);
        assert!(table.try_websocket().is_some());
    }

    #[test]
    fn unauthenticated_sockets_are_capped_per_source() {
        let table = table();
        let _a = table.try_unauthenticated("192.168.1.9", false).unwrap();
        let b = table.try_unauthenticated("192.168.1.9", false).unwrap();
        assert!(table.try_unauthenticated("192.168.1.9", false).is_none());
        assert!(
            table.try_unauthenticated("192.168.1.10", false).is_some(),
            "another source has its own budget"
        );
        drop(b);
        assert!(table.try_unauthenticated("192.168.1.9", false).is_some());
    }

    #[test]
    fn loopback_and_sources_with_an_authenticated_socket_are_exempt() {
        let table = table();
        for _ in 0..5 {
            std::mem::forget(table.try_unauthenticated("127.0.0.1", true).unwrap());
        }
        let _held = [
            table.try_unauthenticated("10.0.0.2", false).unwrap(),
            table.try_unauthenticated("10.0.0.2", false).unwrap(),
        ];
        assert!(table.try_unauthenticated("10.0.0.2", false).is_none());
        let _auth = table.authenticated(Uuid::new_v4(), "10.0.0.2");
        assert!(table.try_unauthenticated("10.0.0.2", false).is_some());
    }

    #[test]
    fn disconnect_cancels_every_connection_of_the_device_only() {
        let table = table();
        let phone = Uuid::new_v4();
        let other = Uuid::new_v4();
        let first = table.authenticated(phone, "a");
        let second = table.authenticated(phone, "b");
        let unrelated = table.authenticated(other, "c");
        assert_eq!(table.connections_of(phone), 2);

        assert_eq!(table.disconnect(phone), 2);
        assert!(first.cancelled().is_cancelled());
        assert!(second.cancelled().is_cancelled());
        assert!(!unrelated.cancelled().is_cancelled());

        drop(first);
        drop(second);
        assert_eq!(table.connections_of(phone), 0);
        assert_eq!(table.disconnect(phone), 0);
    }
}
