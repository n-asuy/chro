//! The phone listener: a WebSocket port separate from the app's HTTP port.
//!
//! It answers any path and reads no headers; devices authenticate inside the
//! encrypted handshake. It binds to loopback until a phone pairs over the
//! network (or one already has), then rebinds the same port on all
//! interfaces. Limits:
//!
//! | limit | value | on breach |
//! |---|---|---|
//! | source | loopback, private, tailnet, same-link | TCP closed before the upgrade |
//! | TCP connections | 256 | TCP closed |
//! | unauthenticated sockets per source | 64 | TCP closed |
//! | WebSockets | 128 | close 1013 `Maximum connections reached` |
//! | handshake | 10 s from accept | close 4002 `E2EE handshake timeout` |
//! | message size | 1 MiB | close 1009 |
//! | consecutive undecryptable frames | 5 | close 4003 `Too many decryption failures` |
//! | requests waiting for dispatch | 256 | close 1013 `Too many pending requests` |
//! | heartbeat | ping every 15 s, 3 unanswered | terminated |
//! | one socket write | 30 s | connection ended |
//! | writer after the connection ended | 2 s to send its close | aborted and joined |
//!
//! Running requests and queued reply bytes are limited by the dispatcher
//! ([`super::dispatch::Limits`]).
//!
//! A device revoked here has its sockets terminated at once (no close
//! handshake). Every received frame rechecks the device's standing first,
//! and the writer rechecks it before an outgoing frame once the last check
//! is a second old, so a credential removed or rotated on disk by anyone
//! stops a connection that only receives within that second.

use std::{
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures::{SinkExt, StreamExt};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::Instant,
};
use tokio_tungstenite::{
    tungstenite::{
        self,
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use super::{
    connections::WriterSlot,
    dispatch::{Outbound, Queued},
    link::{
        Authenticated, DeviceGrant, DeviceLink, FrameKind, Rejection, Responder, SecureChannel,
        SourceClass, Standing,
    },
    network::{classify_source, source_key},
    MobileHub,
};

/// The default port, then the fallback range (6769 stays free for
/// development), then whatever the OS gives.
pub(crate) const DEFAULT_PORT: u16 = 6768;
pub(crate) const FALLBACK_PORTS: std::ops::RangeInclusive<u16> = 6770..=6799;
const FALLBACK_PORT_FILE: &str = "mobile-ws-fallback-port.json";

pub(crate) const CLOSE_INVALID: u16 = 4001;
pub(crate) const CLOSE_HANDSHAKE_TIMEOUT: u16 = 4002;
pub(crate) const CLOSE_DECRYPTION_FAILURES: u16 = 4003;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Timing {
    pub handshake: Duration,
    pub heartbeat: Duration,
    pub heartbeat_misses: u32,
    /// Longest one socket write may take before the connection ends.
    pub write_timeout: Duration,
    /// How long an ended connection's writer may take to send its close
    /// frame before it is aborted.
    pub close_grace: Duration,
    /// Longest the writer sends on a standing it read from the registry.
    pub standing_recheck: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            handshake: Duration::from_secs(10),
            heartbeat: Duration::from_secs(15),
            heartbeat_misses: 3,
            write_timeout: Duration::from_secs(30),
            close_grace: Duration::from_secs(2),
            standing_recheck: Duration::from_secs(1),
        }
    }
}

pub(crate) const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_DECRYPTION_FAILURES: u32 = 5;
const OUTBOUND_QUEUE: usize = 256;
const INBOUND_QUEUE: usize = 256;

/// Which interfaces the listener accepts on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BindScope {
    Loopback,
    Network,
}

enum Control {
    Expose(oneshot::Sender<std::io::Result<()>>),
}

/// The running listener.
pub(crate) struct ListenerHandle {
    port: u16,
    scope: Arc<Mutex<BindScope>>,
    control: mpsc::Sender<Control>,
}

impl ListenerHandle {
    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    pub(crate) fn scope(&self) -> BindScope {
        *self.scope.lock().unwrap()
    }

    /// Rebind the same port on all interfaces. Idempotent. Connections
    /// already open stay open.
    pub(crate) async fn expose(&self) -> std::io::Result<()> {
        if self.scope() == BindScope::Network {
            return Ok(());
        }
        let (reply, answer) = oneshot::channel();
        self.control
            .send(Control::Expose(reply))
            .await
            .map_err(|_| std::io::Error::other("the phone listener stopped"))?;
        answer
            .await
            .map_err(|_| std::io::Error::other("the phone listener stopped"))?
    }
}

/// Which port the phone listener takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortChoice {
    /// The default port, the remembered fallback, the fallback range, then
    /// any free port. A port other than the default is remembered.
    Planned,
    /// Exactly this port, or any free port for 0. Never remembered. For a
    /// second server on the machine, so it cannot take the ports phones
    /// paired with the first one dial.
    Fixed(u16),
}

impl PortChoice {
    pub(crate) fn from_arg(port: Option<u16>) -> Self {
        port.map_or(Self::Planned, Self::Fixed)
    }

    /// Ports to try, in order.
    pub(crate) fn plan(self, data_dir: &Path) -> Vec<u16> {
        match self {
            Self::Planned => port_plan(data_dir),
            Self::Fixed(port) => vec![port],
        }
    }
}

/// Ports to try, in order.
pub(crate) fn port_plan(data_dir: &Path) -> Vec<u16> {
    let mut plan = vec![DEFAULT_PORT];
    if let Some(saved) = saved_fallback_port(data_dir) {
        if saved != DEFAULT_PORT {
            plan.push(saved);
        }
    }
    let fallbacks: Vec<u16> = FALLBACK_PORTS.filter(|port| !plan.contains(port)).collect();
    plan.extend(fallbacks);
    plan.push(0);
    plan
}

fn saved_fallback_port(data_dir: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(data_dir.join(FALLBACK_PORT_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["port"]
        .as_u64()
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0)
}

/// Remember a port other than the default, so phones keep finding this
/// server after a restart.
pub(crate) fn save_fallback_port(data_dir: &Path, port: u16) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(FALLBACK_PORT_FILE);
    let tmp: PathBuf = data_dir.join(format!("{FALLBACK_PORT_FILE}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::json!({ "port": port }).to_string())?;
    std::fs::rename(tmp, path)
}

/// Bind the first free port of `plan` on loopback.
pub(crate) async fn bind_loopback(plan: &[u16]) -> std::io::Result<TcpListener> {
    let mut last_error = None;
    for port in plan {
        match TcpListener::bind((Ipv4Addr::LOCALHOST, *port)).await {
            Ok(listener) => return Ok(listener),
            Err(err) => last_error = Some(err),
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("no ports to try")))
}

/// Accept connections until the hub is dropped.
pub(crate) fn spawn(hub: Arc<MobileHub>, listener: TcpListener) -> std::io::Result<ListenerHandle> {
    let port = listener.local_addr()?.port();
    let scope = Arc::new(Mutex::new(BindScope::Loopback));
    let (control, control_rx) = mpsc::channel(4);
    tokio::spawn(accept_loop(
        Arc::downgrade(&hub),
        listener,
        port,
        Arc::clone(&scope),
        control_rx,
    ));
    Ok(ListenerHandle {
        port,
        scope,
        control,
    })
}

async fn accept_loop(
    hub: std::sync::Weak<MobileHub>,
    mut listener: TcpListener,
    port: u16,
    scope: Arc<Mutex<BindScope>>,
    mut control: mpsc::Receiver<Control>,
) {
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let Some(hub) = hub.upgrade() else { return };
                match accepted {
                    Ok((stream, peer)) => {
                        // Over the TCP cap the stream is dropped, closing it.
                        if let Some(slot) = hub.table().try_tcp() {
                            tokio::spawn(async move {
                                let _slot = slot;
                                serve(hub, stream, peer).await;
                            });
                        }
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "phone listener accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                }
            }
            command = control.recv() => match command {
                Some(Control::Expose(reply)) => {
                    drop(listener);
                    let rebound = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).await;
                    match rebound {
                        Ok(network) => {
                            listener = network;
                            *scope.lock().unwrap() = BindScope::Network;
                            tracing::info!(port, "phone listener accepts network connections");
                            let _ = reply.send(Ok(()));
                        }
                        Err(err) => {
                            match TcpListener::bind((Ipv4Addr::LOCALHOST, port)).await {
                                Ok(loopback) => listener = loopback,
                                Err(rebind) => {
                                    tracing::error!(port, error = %rebind, "phone listener lost its port");
                                    let _ = reply.send(Err(err));
                                    return;
                                }
                            }
                            let _ = reply.send(Err(err));
                        }
                    }
                }
                None => return,
            },
        }
    }
}

fn close_frame(code: u16, reason: &str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: reason.to_string().into(),
    }))
}

type Socket = WebSocketStream<TcpStream>;

async fn serve(hub: Arc<MobileHub>, stream: TcpStream, peer: SocketAddr) {
    let accepted_at = Instant::now();
    let Some(source) = classify_source(peer.ip(), &hub.interfaces()) else {
        tracing::debug!(%peer, "phone listener refused a source outside the local networks");
        return;
    };
    let key = source_key(peer.ip());
    let Some(unauthenticated) = hub
        .table()
        .try_unauthenticated(&key, source == SourceClass::Loopback)
    else {
        return;
    };

    let timing = hub.timing();
    let deadline = accepted_at + timing.handshake;
    let config = WebSocketConfig {
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..Default::default()
    };
    let mut socket = match tokio::time::timeout_at(
        deadline,
        tokio_tungstenite::accept_async_with_config(stream, Some(config)),
    )
    .await
    {
        Ok(Ok(socket)) => socket,
        Ok(Err(_)) | Err(_) => return,
    };
    let Some(_websocket) = hub.table().try_websocket() else {
        let _ = socket
            .send(close_frame(1013, "Maximum connections reached"))
            .await;
        return;
    };

    let authenticated = match tokio::time::timeout_at(
        deadline,
        handshake(hub.link().responder(), &mut socket, source),
    )
    .await
    {
        Err(_) => {
            let _ = socket
                .send(close_frame(
                    CLOSE_HANDSHAKE_TIMEOUT,
                    "E2EE handshake timeout",
                ))
                .await;
            return;
        }
        Ok(Err(HandshakeEnd::Gone)) => return,
        Ok(Err(HandshakeEnd::Refused(rejection))) => {
            if let Some(reply) = rejection.sealed_reply {
                let _ = socket.send(Message::Text(STANDARD.encode(reply))).await;
            }
            let _ = socket
                .send(close_frame(rejection.close_code, &rejection.close_reason))
                .await;
            return;
        }
        Ok(Ok(authenticated)) => authenticated,
    };
    drop(unauthenticated);
    let slot = hub
        .table()
        .authenticated(authenticated.grant.device_id, &key);
    tracing::info!(device = %authenticated.grant.device_id, source = source.as_str(), "phone connected");
    run(hub, socket, authenticated, slot.cancelled()).await;
    drop(slot);
}

enum HandshakeEnd {
    Gone,
    Refused(Rejection),
}

/// Hello, ready, auth, authenticated.
async fn handshake(
    mut responder: Box<dyn Responder>,
    socket: &mut Socket,
    source: SourceClass,
) -> Result<Authenticated, HandshakeEnd> {
    let invalid =
        || HandshakeEnd::Refused(Rejection::new(CLOSE_INVALID, "Invalid handshake message"));
    let hello = next_text(socket).await?.ok_or_else(invalid)?;
    let ready = responder.hello(&hello).map_err(HandshakeEnd::Refused)?;
    socket
        .send(Message::Text(ready))
        .await
        .map_err(|_| HandshakeEnd::Gone)?;

    let auth = next_text(socket).await?.ok_or_else(invalid)?;
    let frame = STANDARD
        .decode(auth.as_bytes())
        .map_err(|_| HandshakeEnd::Refused(Rejection::new(CLOSE_INVALID, "Invalid e2ee_auth")))?;
    // Authenticating reads and writes the registry on disk.
    let authenticated = tokio::task::spawn_blocking(move || responder.authenticate(&frame, source))
        .await
        .map_err(|_| HandshakeEnd::Gone)?
        .map_err(HandshakeEnd::Refused)?;
    socket
        .send(Message::Text(STANDARD.encode(&authenticated.sealed_reply)))
        .await
        .map_err(|_| HandshakeEnd::Gone)?;
    Ok(authenticated)
}

/// The next text message: `Ok(None)` for a binary one (refused during the
/// handshake), `Err(Gone)` when the socket ended.
async fn next_text(socket: &mut Socket) -> Result<Option<String>, HandshakeEnd> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => return Ok(Some(text)),
            Some(Ok(Message::Binary(_))) => return Ok(None),
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return Err(HandshakeEnd::Gone),
        }
    }
}

enum WriterCommand {
    Ping,
    Close(u16, &'static str),
}

/// Read a device's standing from the registry, off the async workers.
/// Fails closed.
async fn standing_of(link: &Arc<dyn DeviceLink>, grant: &DeviceGrant) -> Standing {
    let link = Arc::clone(link);
    let grant = grant.clone();
    tokio::task::spawn_blocking(move || link.standing(&grant))
        .await
        .unwrap_or(Standing::Revoked)
}

/// Serve an authenticated connection until it ends.
async fn run(
    hub: Arc<MobileHub>,
    socket: Socket,
    authenticated: Authenticated,
    revoked: tokio_util::sync::CancellationToken,
) {
    let Authenticated { channel, grant, .. } = authenticated;
    let channel: Arc<Mutex<Box<dyn SecureChannel>>> = Arc::new(Mutex::new(channel));
    let (sink, mut inbound) = socket.split();
    let (outbound_tx, outbound_rx) = mpsc::channel(OUTBOUND_QUEUE);
    let (command_tx, command_rx) = mpsc::unbounded_channel();
    let link = hub.link();
    let timing = hub.timing();
    let mut writer = tokio::spawn(write(
        Writer {
            sink,
            channel: Arc::clone(&channel),
            link: Arc::clone(&link),
            grant: grant.clone(),
            timing,
            _slot: hub.table().writer(),
        },
        outbound_rx,
        command_rx,
    ));
    let session = hub.dispatcher().session(grant.clone(), outbound_tx);
    // Requests are dispatched in arrival order on their own task, so a slow
    // reply never stops this loop from noticing a revoke or a dead peer.
    let (dispatch_tx, mut dispatch_rx) = mpsc::channel::<(FrameKind, Vec<u8>)>(INBOUND_QUEUE);
    let dispatcher = hub.dispatcher().clone();
    let dispatch_session = Arc::clone(&session);
    let dispatch = tokio::spawn(async move {
        while let Some((kind, plaintext)) = dispatch_rx.recv().await {
            match kind {
                FrameKind::Text => dispatcher.on_text(&dispatch_session, &plaintext).await,
                FrameKind::Binary => dispatcher.on_binary(&dispatch_session, &plaintext).await,
            }
        }
    });

    let mut heartbeat =
        tokio::time::interval_at(Instant::now() + timing.heartbeat, timing.heartbeat);
    let mut missed_pongs = 0u32;
    let mut decryption_failures = 0u32;
    let mut writer_ended = false;

    let close = |code: u16, reason: &'static str| {
        let _ = command_tx.send(WriterCommand::Close(code, reason));
    };

    let terminated = loop {
        let message = tokio::select! {
            _ = revoked.cancelled() => break true,
            // The writer stops on a failed or stuck write and on a revoked
            // standing; the connection ends with it.
            _ = &mut writer, if !writer_ended => {
                writer_ended = true;
                break false;
            }
            _ = heartbeat.tick() => {
                if missed_pongs >= timing.heartbeat_misses {
                    tracing::info!(device = %grant.device_id, "phone stopped answering pings");
                    break true;
                }
                missed_pongs += 1;
                let _ = command_tx.send(WriterCommand::Ping);
                continue;
            }
            message = inbound.next() => message,
        };
        let (kind, frame) = match message {
            Some(Ok(Message::Text(text))) => match STANDARD.decode(text.as_bytes()) {
                Ok(frame) => (FrameKind::Text, frame),
                Err(_) => (FrameKind::Text, Vec::new()),
            },
            Some(Ok(Message::Binary(bytes))) => (FrameKind::Binary, bytes),
            Some(Ok(Message::Pong(_))) => {
                missed_pongs = 0;
                continue;
            }
            Some(Ok(Message::Ping(_) | Message::Frame(_))) => continue,
            Some(Err(tungstenite::Error::Capacity(_))) => {
                close(1009, "Message too big");
                break false;
            }
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break false,
        };

        if standing_of(&link, &grant).await == Standing::Revoked {
            close(CLOSE_INVALID, "Unauthorized");
            break false;
        }
        let opened = channel.lock().unwrap().open(kind, &frame);
        let plaintext = match opened {
            Ok(plaintext) => {
                decryption_failures = 0;
                plaintext
            }
            Err(_) => {
                decryption_failures += 1;
                if decryption_failures >= MAX_DECRYPTION_FAILURES {
                    close(CLOSE_DECRYPTION_FAILURES, "Too many decryption failures");
                    break false;
                }
                continue;
            }
        };
        if dispatch_tx.try_send((kind, plaintext)).is_err() {
            close(1013, "Too many pending requests");
            break false;
        }
    };

    // Requests and subscriptions stop with the connection.
    dispatch.abort();
    session.close();
    drop(session);
    if !writer_ended {
        // A terminated connection drops TCP without a close handshake;
        // otherwise the writer gets a short grace to send its close frame.
        let closed_in_time = !terminated && {
            drop(command_tx);
            tokio::time::timeout(timing.close_grace, &mut writer)
                .await
                .is_ok()
        };
        if !closed_in_time {
            // Dropping a JoinHandle would detach a writer stuck on a peer
            // that stopped reading, keeping its socket and queue alive.
            writer.abort();
            let _ = writer.await;
        }
    }
    tracing::info!(device = %grant.device_id, terminated, "phone disconnected");
}

/// A connection's socket writer and what it checks before sending.
struct Writer {
    sink: futures::stream::SplitSink<Socket, Message>,
    channel: Arc<Mutex<Box<dyn SecureChannel>>>,
    link: Arc<dyn DeviceLink>,
    grant: DeviceGrant,
    timing: Timing,
    _slot: WriterSlot,
}

impl Writer {
    /// Send one message within the write timeout.
    async fn send(&mut self, message: Message) -> bool {
        matches!(
            tokio::time::timeout(self.timing.write_timeout, self.sink.send(message)).await,
            Ok(Ok(()))
        )
    }

    async fn close(&mut self, code: u16, reason: &str) {
        self.send(close_frame(code, reason)).await;
    }

    async fn finish(&mut self) {
        let _ = tokio::time::timeout(self.timing.write_timeout, self.sink.close()).await;
    }
}

/// Seal and send frames in order, plus pings and the final close frame.
/// Returns when the connection should end: on a close, a failed or stuck
/// write, or a standing that no longer holds.
async fn write(
    mut writer: Writer,
    mut outbound: mpsc::Receiver<Queued>,
    mut commands: mpsc::UnboundedReceiver<WriterCommand>,
) {
    // The connection authenticated just now.
    let mut standing_read_at = Instant::now();
    loop {
        let (message, _queued) = tokio::select! {
            biased;
            command = commands.recv() => match command {
                Some(WriterCommand::Ping) => (Message::Ping(Vec::new()), None),
                Some(WriterCommand::Close(code, reason)) => {
                    writer.close(code, reason).await;
                    return;
                }
                None => {
                    writer.finish().await;
                    return;
                }
            },
            queued = outbound.recv() => match queued {
                Some(queued) => {
                    if standing_read_at.elapsed() >= writer.timing.standing_recheck {
                        if standing_of(&writer.link, &writer.grant).await == Standing::Revoked {
                            writer.close(CLOSE_INVALID, "Unauthorized").await;
                            return;
                        }
                        standing_read_at = Instant::now();
                    }
                    let message = match &queued.frame {
                        Outbound::Text(text) => {
                            let sealed = writer.channel.lock().unwrap().seal(FrameKind::Text, text.as_bytes());
                            Message::Text(STANDARD.encode(sealed))
                        }
                        Outbound::Binary(bytes) => {
                            Message::Binary(writer.channel.lock().unwrap().seal(FrameKind::Binary, bytes))
                        }
                    };
                    // The frame keeps its queued bytes until it is sent.
                    (message, Some(queued))
                }
                // Every session is gone; wait for the reader to finish.
                None => match commands.recv().await {
                    Some(WriterCommand::Close(code, reason)) => {
                        writer.close(code, reason).await;
                        return;
                    }
                    _ => {
                        writer.finish().await;
                        return;
                    }
                },
            },
        };
        if !writer.send(message).await {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_plan_prefers_the_default_then_the_saved_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let plan = port_plan(dir.path());
        assert_eq!(plan[0], 6768);
        assert_eq!(plan[1], 6770);
        assert_eq!(*plan.last().unwrap(), 0);
        assert!(!plan.contains(&6769), "6769 stays free for development");

        save_fallback_port(dir.path(), 6783).unwrap();
        let plan = port_plan(dir.path());
        assert_eq!(&plan[..3], &[6768, 6783, 6770]);
        assert_eq!(plan.iter().filter(|port| **port == 6783).count(), 1);
    }

    #[test]
    fn a_corrupt_saved_port_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FALLBACK_PORT_FILE), "{not json").unwrap();
        assert_eq!(port_plan(dir.path())[1], 6770);
    }

    #[test]
    fn a_fixed_port_is_the_whole_plan() {
        let dir = tempfile::tempdir().unwrap();
        save_fallback_port(dir.path(), 6783).unwrap();
        assert_eq!(PortChoice::Fixed(7001).plan(dir.path()), vec![7001]);
        assert_eq!(PortChoice::Fixed(0).plan(dir.path()), vec![0]);
        assert_eq!(PortChoice::from_arg(None), PortChoice::Planned);
        assert_eq!(PortChoice::from_arg(Some(0)), PortChoice::Fixed(0));
        assert_eq!(PortChoice::Planned.plan(dir.path()), port_plan(dir.path()));
    }

    #[tokio::test]
    async fn binding_skips_taken_ports() {
        let taken = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let taken_port = taken.local_addr().unwrap().port();
        let listener = bind_loopback(&[taken_port, 0]).await.unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), taken_port);
        assert!(listener.local_addr().unwrap().ip().is_loopback());
    }
}
