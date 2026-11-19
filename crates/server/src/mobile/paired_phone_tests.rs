//! A phone built from the library's public primitives pairs with a real
//! server through the real listener and [`DiskLink`]: the desktop's offer,
//! the encrypted handshake, every RPC family, the ticket exchange and
//! revocation. Servers on separate databases stay apart.

use std::{path::Path, sync::Arc};

use axum::http::{Method, StatusCode};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures::{SinkExt, StreamExt};
use mobile_link::{
    nonce, transcript, validate_ready, Context, Hello, HostKey, Kind, PairingOffer, SessionKeys,
};
use rand::RngCore;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use super::{
    data_dir,
    disk_link::{DiskLink, HOST_KEY_FILE, REGISTRY_FILE},
    link::{DeviceGrant, DeviceLink, FrameKind, SourceClass, Standing},
    listener::{BindScope, PortChoice},
    tests::{close_code, rpc, ws_connect, Client, WAIT},
    HubConfig, MobileHub,
};
use crate::test_support::{self, TestApp};

const PHONE_TO_HOST: u8 = 0;
const HOST_TO_PHONE: u8 = 1;

fn random32() -> [u8; 32] {
    let mut bytes = [0; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

fn device_token() -> String {
    let mut bytes = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The offer inside a `chro://pair?code=` URL, as the phone decodes it.
fn decode_offer(pairing_url: &str) -> PairingOffer {
    let code = pairing_url
        .strip_prefix("chro://pair?code=")
        .expect("a chro pairing URL");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(code).expect("base64url")).expect("an offer")
}

fn public_key(offer: &PairingOffer) -> [u8; 32] {
    STANDARD
        .decode(&offer.public_key_b64)
        .unwrap()
        .try_into()
        .unwrap()
}

/// The phone's half of the handshake, independent of the transport.
struct PhoneHandshake {
    key: HostKey,
    hello_json: String,
    hello: Hello,
}

impl PhoneHandshake {
    fn new() -> Self {
        let key = HostKey::generate();
        let hello_json = json!({
            "type": "e2ee_hello",
            "v": 2,
            "clientPublicKeyB64": STANDARD.encode(key.public_key()),
            "clientNonceB64": STANDARD.encode(random32()),
            "capabilities": {"framing": [2], "payloadKinds": ["text", "binary"]},
            "context": Context::direct(),
        })
        .to_string();
        let hello = Hello::parse(&hello_json, &Context::direct()).expect("a valid hello");
        Self {
            key,
            hello_json,
            hello,
        }
    }

    /// Check the ready message against the pinned host key and derive the
    /// session keys.
    fn keys(&self, ready: &str, pinned: &[u8; 32]) -> SessionKeys {
        let desktop_nonce = validate_ready(ready, &self.hello, pinned).expect("a valid ready");
        let client_nonce = self.hello.client_nonce;
        SessionKeys::derive(
            self.key.shared(*pinned).unwrap(),
            &client_nonce,
            &desktop_nonce,
            &transcript(
                &Context::direct(),
                &self.key.public_key(),
                &client_nonce,
                pinned,
                &desktop_nonce,
            ),
        )
    }
}

fn sealed_auth(keys: &SessionKeys, token: &str) -> Vec<u8> {
    let auth = json!({
        "type": "e2ee_auth",
        "v": 2,
        "transcriptHashB64": STANDARD.encode(keys.transcript_hash),
        "deviceToken": token,
    });
    keys.seal_at(PHONE_TO_HOST, Kind::Text, 0, auth.to_string().as_bytes())
        .unwrap()
}

/// How a handshake was refused.
#[derive(Debug)]
struct Refused {
    /// The code of the sealed `e2ee_error`, when one came.
    error: Option<String>,
    close: Option<u16>,
}

struct Phone {
    socket: Client,
    keys: SessionKeys,
    token: String,
    sent: u64,
    received: u64,
    next_id: u64,
}

impl Phone {
    /// Open a socket to `port` and run the handshake as `token`, pinning
    /// `host_key` as the offer says.
    async fn connect(port: u16, host_key: &[u8; 32], token: &str) -> Result<Self, Refused> {
        let mut socket = ws_connect(port, "/").await;
        let handshake = PhoneHandshake::new();
        socket
            .send(Message::Text(handshake.hello_json.clone()))
            .await
            .unwrap();
        let ready = match next(&mut socket).await {
            Some(Message::Text(text)) => text,
            other => panic!("expected ready, got {other:?}"),
        };
        let keys = handshake.keys(&ready, host_key);
        socket
            .send(Message::Text(STANDARD.encode(sealed_auth(&keys, token))))
            .await
            .unwrap();
        let sealed = match next(&mut socket).await {
            Some(Message::Text(text)) => STANDARD.decode(text).unwrap(),
            other => panic!("expected a sealed reply, got {other:?}"),
        };
        assert_eq!(
            sealed[..24],
            nonce(&keys.session_id, HOST_TO_PHONE, Kind::Text, 0),
            "the first host frame carries counter 0 in its nonce"
        );
        let reply: Value = serde_json::from_slice(
            &keys
                .open_at(HOST_TO_PHONE, Kind::Text, 0, &sealed)
                .expect("sealed with the session keys"),
        )
        .unwrap();
        if reply["type"] != "e2ee_authenticated" {
            assert_eq!(reply["type"], "e2ee_error", "{reply}");
            return Err(Refused {
                error: reply["error"]["code"].as_str().map(str::to_string),
                close: close_code(&mut socket).await,
            });
        }
        assert_eq!(
            reply["transcriptHashB64"],
            STANDARD.encode(keys.transcript_hash)
        );
        Ok(Self {
            socket,
            keys,
            token: token.to_string(),
            sent: 1,
            received: 1,
            next_id: 0,
        })
    }

    async fn send_rpc(&mut self, method: &str, params: Value) -> String {
        self.next_id += 1;
        let id = format!("phone-{}", self.next_id);
        let envelope =
            json!({"id": id, "deviceToken": self.token, "method": method, "params": params});
        let sealed = self
            .keys
            .seal_at(
                PHONE_TO_HOST,
                Kind::Text,
                self.sent,
                envelope.to_string().as_bytes(),
            )
            .unwrap();
        self.sent += 1;
        self.socket
            .send(Message::Text(STANDARD.encode(sealed)))
            .await
            .unwrap();
        id
    }

    /// The next text reply. Binary frames share the counter and are skipped.
    async fn reply(&mut self) -> Value {
        loop {
            let message = next(&mut self.socket).await.expect("the socket is open");
            let (kind, sealed) = match message {
                Message::Text(text) => (Kind::Text, STANDARD.decode(text).unwrap()),
                Message::Binary(bytes) => (Kind::Binary, bytes),
                _ => continue,
            };
            let plaintext = self
                .keys
                .open_at(HOST_TO_PHONE, kind, self.received, &sealed)
                .expect("frames arrive in order");
            self.received += 1;
            if kind == Kind::Text {
                return serde_json::from_slice(&plaintext).unwrap();
            }
        }
    }

    /// The reply to `id`, past stream replies of other calls.
    async fn reply_to(&mut self, id: &str) -> Value {
        loop {
            let reply = self.reply().await;
            if reply["id"] == id {
                return reply;
            }
            assert_eq!(reply["streaming"], true, "an unexpected reply: {reply}");
        }
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.send_rpc(method, params).await;
        let reply = self.reply_to(&id).await;
        assert_eq!(reply["ok"], true, "{method}: {reply}");
        reply["result"].clone()
    }
}

/// The next message other than pings and pongs; `None` once the socket ended.
async fn next(socket: &mut Client) -> Option<Message> {
    loop {
        match tokio::time::timeout(WAIT, socket.next())
            .await
            .expect("a message in time")
        {
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            Some(Ok(message)) => return Some(message),
            Some(Err(_)) | None => return None,
        }
    }
}

/// A server on its own database whose phone listener runs on [`DiskLink`].
struct Server {
    app: TestApp,
    link: DiskLink,
    hub: Arc<MobileHub>,
    port: u16,
}

async fn server() -> Server {
    let app = test_support::app().await;
    let dir = data_dir(&app.dir.path().join("chro.sqlite"));
    let link = DiskLink::open(&dir).expect("the pairing state opens");
    let hub = MobileHub::start(
        app.state.clone(),
        Arc::new(link.clone()),
        &dir,
        PortChoice::Fixed(0),
    )
    .await
    .expect("the listener starts");
    let port = hub.port().unwrap();
    Server {
        app,
        link,
        hub,
        port,
    }
}

impl Server {
    /// Issue an offer from the desktop pane, as the phone would scan it.
    async fn offer(&self, rotate: bool) -> (Value, PairingOffer) {
        let (status, body) = rpc(
            &self.app,
            Method::POST,
            "/rpc/mobile/pairing-offer",
            Some(json!({"address": "127.0.0.1", "rotate": rotate})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let offer = decode_offer(body["pairingUrl"].as_str().unwrap());
        (body, offer)
    }

    async fn devices(&self) -> Vec<Value> {
        let (status, body) = rpc(&self.app, Method::GET, "/rpc/mobile/devices", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["devices"].as_array().unwrap().clone()
    }
}

#[tokio::test]
async fn a_phone_pairs_calls_exchanges_its_ticket_and_is_cut_off_by_revoke() {
    let server = server().await;

    // The desktop's offer: a QR of a v2 offer for this listener and key.
    let (body, offer) = server.offer(false).await;
    let endpoint = format!("ws://127.0.0.1:{}", server.port);
    assert_eq!(body["endpoint"], endpoint);
    assert!(body["qrSvg"].as_str().unwrap().contains("<svg"));
    let expires_at = body["expiresAt"].as_u64().expect("epoch milliseconds");
    let now = u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap();
    assert!(expires_at > now + 9 * 60 * 1000 && expires_at <= now + 10 * 60 * 1000);
    assert_eq!(offer.v, 2);
    assert_eq!(offer.endpoint, endpoint);
    assert_eq!(offer.scope, "mobile");
    assert_eq!(public_key(&offer), server.link.public_key());
    assert!(
        server.devices().await.is_empty(),
        "an unscanned offer is not a paired device"
    );
    let (_, again) = server.offer(false).await;
    assert_eq!(
        again.device_token, offer.device_token,
        "a fresh unscanned offer is reused"
    );

    // Hello, ready, auth, authenticated with the QR ticket.
    let host_key = public_key(&offer);
    let mut ticket_phone = Phone::connect(server.port, &host_key, &offer.device_token)
        .await
        .expect("the ticket authenticates");

    let declared = ticket_phone
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    assert_eq!(declared["apiGeneration"], 1);

    let status = ticket_phone.call("status.get", json!({})).await;
    assert_eq!(status["deviceId"], offer.paired_device_id);
    assert_eq!(status["apiGeneration"], 1);
    assert!(status["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("pairing.ticket-exchange.v1")));
    assert!(status["machineName"].is_string());

    let response = ticket_phone
        .call("request", json!({"method": "GET", "path": "/v1/status"}))
        .await;
    assert_eq!(response["status"], 200, "{response}");
    assert_eq!(response["body"]["ok"], true, "{response}");

    let project = server.app.project("phone-repo").await;
    server.app.task(&project, "Seen from the phone").await;
    let subscription = ticket_phone
        .send_rpc(
            "subscribe",
            json!({"stream": "/streams/tasks", "params": {}}),
        )
        .await;
    let ready = ticket_phone.reply_to(&subscription).await;
    assert_eq!(ready["streaming"], true, "{ready}");
    assert_eq!(ready["result"]["type"], "ready", "{ready}");
    let subscription_id = ready["result"]["subscriptionId"].clone();
    let message = ticket_phone.reply_to(&subscription).await;
    assert_eq!(message["result"]["type"], "message", "{message}");
    assert_eq!(message["result"]["subscriptionId"], subscription_id);
    assert!(
        message["result"]["data"]
            .to_string()
            .contains("Seen from the phone"),
        "the snapshot carries the task: {message}"
    );
    ticket_phone
        .call(
            "subscribe.unsubscribe",
            json!({"subscriptionId": subscription_id}),
        )
        .await;

    // The phone trades the ticket for a token of its own.
    let own_token = device_token();
    let exchanged = ticket_phone
        .call("pairing.exchangeTicket", json!({"deviceToken": own_token}))
        .await;
    assert_eq!(exchanged["deviceId"], offer.paired_device_id);

    let devices = server.devices().await;
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["id"], offer.paired_device_id);
    assert!(devices[0]["name"].as_str().unwrap().starts_with("Mobile "));
    assert!(devices[0]["pairedAt"].is_u64());
    assert!(devices[0]["lastSeenAt"].is_u64());

    // Authenticating with the new token completes the exchange: the ticket
    // stops working and its socket closes on its next frame.
    let mut phone = Phone::connect(server.port, &host_key, &own_token)
        .await
        .expect("the exchanged token authenticates");
    ticket_phone.send_rpc("status.get", json!({})).await;
    assert_eq!(close_code(&mut ticket_phone.socket).await, Some(4001));
    let refused = Phone::connect(server.port, &host_key, &offer.device_token)
        .await
        .err()
        .expect("the ticket is spent");
    assert_eq!(refused.error.as_deref(), Some("unauthorized"));
    assert_eq!(refused.close, Some(4001));

    // A reconnected phone declares its API again before calling.
    phone
        .call(
            "runtime.clientCapabilities.update",
            json!({"clientCapabilities": [], "apiGeneration": 1}),
        )
        .await;
    let status = phone.call("status.get", json!({"probe": true})).await;
    assert_eq!(status["deviceId"], offer.paired_device_id);

    // Revoking from the desktop removes the device on disk and cuts the
    // socket at once, without a close handshake.
    let (status, body) = rpc(
        &server.app,
        Method::DELETE,
        &format!("/rpc/mobile/devices/{}", offer.paired_device_id),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({}));
    assert_eq!(close_code(&mut phone.socket).await, None);
    assert!(server.devices().await.is_empty());
    let refused = Phone::connect(server.port, &host_key, &own_token)
        .await
        .err()
        .expect("a revoked token is refused");
    assert_eq!(refused.error.as_deref(), Some("unauthorized"));
    let device_id = uuid::Uuid::parse_str(&offer.paired_device_id).unwrap();
    assert_eq!(server.hub.table().connections_of(device_id), 0);
}

#[tokio::test]
async fn a_handshake_pinned_to_another_key_or_with_a_bad_proof_is_refused() {
    let server = server().await;
    let (_, offer) = server.offer(false).await;

    let mut socket = ws_connect(server.port, "/").await;
    socket.send(Message::Text("{}".into())).await.unwrap();
    assert_eq!(close_code(&mut socket).await, Some(4001));

    // A phone that pins another key cannot derive the session keys.
    let mut socket = ws_connect(server.port, "/").await;
    let handshake = PhoneHandshake::new();
    socket
        .send(Message::Text(handshake.hello_json.clone()))
        .await
        .unwrap();
    let Some(Message::Text(ready)) = next(&mut socket).await else {
        panic!("expected ready");
    };
    let wrong_key = HostKey::generate().public_key();
    assert!(validate_ready(&ready, &handshake.hello, &wrong_key).is_err());

    // A proof over another transcript is a bad proof.
    let keys = handshake.keys(&ready, &public_key(&offer));
    let auth = json!({
        "type": "e2ee_auth",
        "v": 2,
        "transcriptHashB64": STANDARD.encode([0u8; 32]),
        "deviceToken": offer.device_token,
    });
    let sealed = keys
        .seal_at(PHONE_TO_HOST, Kind::Text, 0, auth.to_string().as_bytes())
        .unwrap();
    socket
        .send(Message::Text(STANDARD.encode(sealed)))
        .await
        .unwrap();
    let Some(Message::Text(reply)) = next(&mut socket).await else {
        panic!("expected a sealed error");
    };
    let error: Value = serde_json::from_slice(
        &keys
            .open_at(
                HOST_TO_PHONE,
                Kind::Text,
                0,
                &STANDARD.decode(reply).unwrap(),
            )
            .unwrap(),
    )
    .unwrap();
    assert_eq!(error["error"]["code"], "bad_proof");
    assert_eq!(close_code(&mut socket).await, Some(4001));
    assert!(
        server.devices().await.is_empty(),
        "a refused handshake pairs nothing"
    );
}

#[tokio::test]
async fn servers_on_separate_databases_pair_their_own_phones() {
    let main = server().await;
    let isolated = server().await;
    assert_ne!(main.port, isolated.port);
    assert_ne!(main.link.public_key(), isolated.link.public_key());
    for server in [&main, &isolated] {
        let dir = data_dir(&server.app.dir.path().join("chro.sqlite"));
        assert!(dir.starts_with(server.app.dir.path()));
        assert!(dir.join(HOST_KEY_FILE).is_file());
        assert!(
            !dir.join("mobile-ws-fallback-port.json").exists(),
            "a fixed port is never remembered"
        );
    }

    // A ticket of the main server means nothing to the isolated one, even
    // when the phone pins the isolated server's key.
    let (_, offer) = main.offer(false).await;
    let refused = Phone::connect(
        isolated.port,
        &isolated.link.public_key(),
        &offer.device_token,
    )
    .await
    .err()
    .expect("another server's ticket");
    assert_eq!(refused.error.as_deref(), Some("unauthorized"));

    let (_, isolated_offer) = isolated.offer(false).await;
    Phone::connect(
        isolated.port,
        &public_key(&isolated_offer),
        &isolated_offer.device_token,
    )
    .await
    .expect("the isolated server pairs its own phone");
    assert_eq!(isolated.devices().await.len(), 1);
    assert!(main.devices().await.is_empty());
}

#[test]
fn pairing_state_lives_beside_the_database() {
    assert_eq!(
        data_dir(Path::new("/data/chro/db.sqlite")),
        Path::new("/data/chro/mobile")
    );
    assert_eq!(
        data_dir(Path::new("/tmp/isolated/db.sqlite")),
        Path::new("/tmp/isolated/mobile")
    );
}

#[test]
fn an_unreadable_host_key_is_an_error_and_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(HOST_KEY_FILE), "not a key").unwrap();
    assert!(DiskLink::open(dir.path()).is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join(HOST_KEY_FILE)).unwrap(),
        "not a key"
    );

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(REGISTRY_FILE), "[{").unwrap();
    assert!(DiskLink::open(dir.path()).is_err());
}

/// Run the handshake against `link` in memory, as the listener would for a
/// connection from `source`.
fn pair_in_memory(link: &DiskLink, token: &str, source: SourceClass) -> DeviceGrant {
    let host_key = link.public_key();
    let handshake = PhoneHandshake::new();
    let mut responder = link.responder();
    let ready = responder.hello(&handshake.hello_json).expect("ready");
    let keys = handshake.keys(&ready, &host_key);
    match responder.authenticate(&sealed_auth(&keys, token), source) {
        Ok(authenticated) => {
            let mut channel = authenticated.channel;
            // The channel continues the session after the handshake.
            let frame = keys
                .seal_at(PHONE_TO_HOST, Kind::Binary, 1, b"payload")
                .unwrap();
            assert_eq!(channel.open(FrameKind::Binary, &frame).unwrap(), b"payload");
            assert!(
                channel.open(FrameKind::Binary, &frame).is_err(),
                "no replay"
            );
            let sealed = channel.seal(FrameKind::Text, b"reply");
            assert_eq!(
                keys.open_at(HOST_TO_PHONE, Kind::Text, 1, &sealed).unwrap(),
                b"reply"
            );
            authenticated.grant
        }
        Err(rejection) => panic!("refused: {rejection:?}"),
    }
}

fn issue(link: &DiskLink) -> PairingOffer {
    decode_offer(
        &link
            .issue_offer("ws://127.0.0.1:6768", true)
            .unwrap()
            .pairing_url,
    )
}

#[test]
fn ticket_exchange_and_standing_follow_the_registry() {
    let dir = tempfile::tempdir().unwrap();
    let link = DiskLink::open(dir.path()).unwrap();
    let offer = issue(&link);
    let ticket = pair_in_memory(&link, &offer.device_token, SourceClass::Loopback);
    assert!(ticket.is_ticket);
    assert_eq!(ticket.token, offer.device_token);
    assert_eq!(ticket.device_id.to_string(), offer.paired_device_id);
    assert_eq!(link.standing(&ticket), Standing::Active);

    let code = |result: Result<uuid::Uuid, super::link::TicketError>| result.unwrap_err().code;
    assert_eq!(
        code(link.exchange_ticket(&ticket, "not-hex")),
        "invalid_argument"
    );
    let own = device_token();
    assert_eq!(
        link.exchange_ticket(&ticket, &own).unwrap(),
        ticket.device_id
    );
    assert_eq!(
        link.exchange_ticket(&ticket, &own).unwrap(),
        ticket.device_id,
        "repeating the same exchange succeeds"
    );
    assert_eq!(
        code(link.exchange_ticket(&ticket, &device_token())),
        "ticket_exchange_pending"
    );
    assert_eq!(
        link.standing(&ticket),
        Standing::Active,
        "the ticket holds until the new token authenticates"
    );

    let device = pair_in_memory(&link, &own, SourceClass::Loopback);
    assert!(!device.is_ticket);
    assert_eq!(device.revision, ticket.revision + 1);
    assert_eq!(link.standing(&ticket), Standing::Revoked);
    assert_eq!(link.standing(&device), Standing::Active);
    assert_eq!(
        code(link.exchange_ticket(&device, &device_token())),
        "not_a_ticket"
    );

    assert!(link.revoke(device.device_id).unwrap());
    assert!(!link.revoke(device.device_id).unwrap());
    assert_eq!(link.standing(&device), Standing::Revoked);
    assert_eq!(
        code(link.exchange_ticket(&ticket, &device_token())),
        "device_not_found"
    );
}

#[tokio::test]
async fn a_phone_paired_over_the_network_reopens_the_listener_after_a_restart() {
    let app = test_support::app().await;
    let dir = tempfile::tempdir().unwrap();
    let link = DiskLink::open(dir.path()).unwrap();
    let local = issue(&link);
    pair_in_memory(&link, &local.device_token, SourceClass::Loopback);

    let start = |link: DiskLink| {
        let hub = MobileHub::new(app.state.clone(), Arc::new(link), HubConfig::default());
        async move {
            hub.open(TcpListener::bind("127.0.0.1:0").await.unwrap())
                .await
                .unwrap();
            hub.scope()
        }
    };
    assert_eq!(
        start(DiskLink::open(dir.path()).unwrap()).await,
        Some(BindScope::Loopback)
    );

    let remote = issue(&link);
    let grant = pair_in_memory(&link, &remote.device_token, SourceClass::Tailnet);
    let restarted = DiskLink::open(dir.path()).unwrap();
    let devices = restarted.devices().unwrap();
    let remote_row = devices
        .iter()
        .find(|device| device.id == grant.device_id)
        .unwrap();
    assert_eq!(remote_row.last_source, Some(SourceClass::Tailnet));
    assert_eq!(start(restarted).await, Some(BindScope::Network));
}
