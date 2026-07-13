//! CDP transport: one WebSocket to Chrome, request/response correlation, and a
//! fan-out of unsolicited events.
//!
//! This is the Rust analog of a reference Python CDP client plus its daemon's
//! event `tap`. A single reader task owns the socket read
//! half: messages carrying an `id` resolve the matching pending request; every
//! other message is a CDP event and is broadcast to subscribers. A writer task
//! owns the socket write half and drains an mpsc queue, so `send` is callable
//! from any task without locking the sink.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::error::{BrowserError, Result};

/// Default per-command deadline. Chrome answers control commands in
/// milliseconds; a multi-second ceiling only trips on a wedged connection.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// Bounded ring of recent events for late subscribers. Mirrors the daemon's
/// `BUF = 500` event buffer so a consumer that subscribes a moment late still
/// sees navigation/load it would otherwise miss.
const EVENT_CHANNEL_CAPACITY: usize = 512;

/// An unsolicited CDP event (`method` + `params`), tagged with the originating
/// flat-session id when Chrome includes one.
#[derive(Debug, Clone)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<std::result::Result<Value, String>>>>>;

/// A live CDP connection. Cheap to clone — all clones share one socket.
#[derive(Clone)]
pub struct CdpClient {
    next_id: Arc<AtomicU64>,
    pending: Pending,
    outbound_tx: mpsc::UnboundedSender<Message>,
    events_tx: broadcast::Sender<CdpEvent>,
}

impl CdpClient {
    /// Open the WebSocket and spawn the reader/writer pumps.
    pub async fn connect(ws_url: &str) -> Result<Self> {
        let (stream, _resp) = connect_async(ws_url)
            .await
            .map_err(|e| BrowserError::Connect(e.to_string()))?;
        let (mut sink, mut read) = stream.split();

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (outbound_tx, mut outbound_rx) = mpsc::unbounded_channel::<Message>();

        // Writer pump: serialize outbound commands onto the socket.
        tokio::spawn(async move {
            while let Some(msg) = outbound_rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // Reader pump: route responses to pending requests, broadcast events.
        let reader_pending = Arc::clone(&pending);
        let reader_events = events_tx.clone();
        tokio::spawn(async move {
            while let Some(frame) = read.next().await {
                let text = match frame {
                    Ok(Message::Text(text)) => text,
                    Ok(Message::Binary(bytes)) => match String::from_utf8(bytes) {
                        Ok(text) => text,
                        Err(_) => continue,
                    },
                    Ok(Message::Close(_)) | Err(_) => break,
                    Ok(_) => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                route_message(value, &reader_pending, &reader_events);
            }
            // Socket closed: fail every in-flight request so callers unblock.
            let mut guard = reader_pending.lock().expect("cdp pending mutex poisoned");
            for (_, tx) in guard.drain() {
                let _ = tx.send(Err("CDP connection closed".to_string()));
            }
        });

        Ok(Self {
            next_id: Arc::new(AtomicU64::new(1)),
            pending,
            outbound_tx,
            events_tx,
        })
    }

    /// Subscribe to the event fan-out. Lagged receivers drop oldest events
    /// rather than blocking the reader.
    pub fn events(&self) -> broadcast::Receiver<CdpEvent> {
        self.events_tx.subscribe()
    }

    /// Send a CDP command and await its result.
    ///
    /// `session_id` selects the flat session (`None` for browser-level calls).
    /// Browser-level `Target.*` commands MUST pass `None` — Chrome otherwise
    /// silently routes them to the browser target (as the reference daemon documents).
    pub async fn send(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("cdp pending mutex poisoned")
            .insert(id, tx);

        let mut payload = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session_id {
            payload["sessionId"] = json!(sid);
        }

        if self
            .outbound_tx
            .send(Message::Text(payload.to_string()))
            .is_err()
        {
            self.pending
                .lock()
                .expect("cdp pending mutex poisoned")
                .remove(&id);
            return Err(BrowserError::Closed);
        }

        match tokio::time::timeout(COMMAND_TIMEOUT, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(BrowserError::Protocol {
                method: method.to_string(),
                message,
            }),
            Ok(Err(_)) => Err(BrowserError::Closed),
            Err(_) => {
                self.pending
                    .lock()
                    .expect("cdp pending mutex poisoned")
                    .remove(&id);
                Err(BrowserError::Timeout(method.to_string()))
            }
        }
    }
}

/// Dispatch one parsed message: a response resolves its pending request, an
/// event is broadcast. Split out so the routing is unit-testable.
fn route_message(value: Value, pending: &Pending, events: &broadcast::Sender<CdpEvent>) {
    if let Some(id) = value.get("id").and_then(Value::as_u64) {
        let Some(tx) = pending
            .lock()
            .expect("cdp pending mutex poisoned")
            .remove(&id)
        else {
            return;
        };
        if let Some(err) = value.get("error") {
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown CDP error")
                .to_string();
            let _ = tx.send(Err(message));
        } else {
            let result = value.get("result").cloned().unwrap_or_else(|| json!({}));
            let _ = tx.send(Ok(result));
        }
        return;
    }

    if let Some(method) = value.get("method").and_then(Value::as_str) {
        let event = CdpEvent {
            method: method.to_string(),
            params: value.get("params").cloned().unwrap_or_else(|| json!({})),
            session_id: value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string),
        };
        // Best-effort: with no subscribers `send` errors and we drop the event.
        let _ = events.send(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make() -> (Pending, broadcast::Sender<CdpEvent>) {
        (
            Arc::new(Mutex::new(HashMap::new())),
            broadcast::channel(16).0,
        )
    }

    #[test]
    fn response_resolves_pending_request() {
        let (pending, events) = make();
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert(7, tx);

        route_message(json!({"id": 7, "result": {"ok": true}}), &pending, &events);

        let got = rx.blocking_recv().unwrap().unwrap();
        assert_eq!(got, json!({"ok": true}));
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn error_response_is_propagated() {
        let (pending, events) = make();
        let (tx, rx) = oneshot::channel();
        pending.lock().unwrap().insert(3, tx);

        route_message(
            json!({"id": 3, "error": {"code": -32000, "message": "boom"}}),
            &pending,
            &events,
        );

        assert_eq!(rx.blocking_recv().unwrap().unwrap_err(), "boom");
    }

    #[test]
    fn event_is_broadcast_with_session() {
        let (pending, events) = make();
        let mut rx = events.subscribe();

        route_message(
            json!({"method": "Page.loadEventFired", "params": {"t": 1}, "sessionId": "S1"}),
            &pending,
            &events,
        );

        let ev = rx.blocking_recv().unwrap();
        assert_eq!(ev.method, "Page.loadEventFired");
        assert_eq!(ev.session_id.as_deref(), Some("S1"));
        assert_eq!(ev.params, json!({"t": 1}));
    }

    #[test]
    fn unknown_response_id_is_ignored() {
        let (pending, events) = make();
        // No panic, no subscriber needed.
        route_message(json!({"id": 999, "result": {}}), &pending, &events);
        assert!(pending.lock().unwrap().is_empty());
    }
}
