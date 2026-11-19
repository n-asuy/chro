use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub const HANDSHAKE_TIMEOUT_MS: u64 = 10000;
pub const MAX_DECRYPTION_FAILURES: u8 = 5;
pub const MAX_INBOUND_BYTES: usize = 1024 * 1024;
pub const HEARTBEAT_INTERVAL_MS: u64 = 15000;
pub const HEARTBEAT_MISSES: u8 = 3;
pub const MAX_CONNECTIONS: usize = 128;
pub const MAX_UNAUTHENTICATED_PER_SOURCE: usize = 64;
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Context {
    protocol: String,
    initiator: String,
    responder: String,
    transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    relay_host_id: Option<String>,
}
impl Context {
    pub fn direct() -> Self {
        Self::new("direct", None).unwrap()
    }
    pub fn new(transport: &str, relay_host_id: Option<String>) -> Result<Self> {
        if !matches!(
            (transport, &relay_host_id),
            ("direct", None) | ("relay", Some(_))
        ) || relay_host_id.as_ref().is_some_and(|s| {
            s.len() != 16
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        }) {
            return Err(Error::Invalid("context"));
        }
        Ok(Self {
            protocol: PROTOCOL.into(),
            initiator: "mobile".into(),
            responder: "desktop".into(),
            transport: transport.into(),
            relay_host_id,
        })
    }
    pub fn transport(&self) -> &str {
        &self.transport
    }
    pub fn relay_host_id(&self) -> Option<&str> {
        self.relay_host_id.as_deref()
    }
}
fn exact(v: &Value, keys: &[&str]) -> Result<()> {
    let m = v.as_object().ok_or(Error::Invalid("object"))?;
    if m.len() != keys.len() || keys.iter().any(|k| !m.contains_key(*k)) {
        return Err(Error::Invalid("key set"));
    }
    Ok(())
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or(Error::Invalid("string"))
}
fn version(v: &Value) -> Result<()> {
    if v["v"].as_u64() != Some(2) {
        return Err(Error::Invalid("version"));
    }
    Ok(())
}
fn capabilities(v: &Value, selection: bool) -> Result<()> {
    exact(v, &["framing", "payloadKinds"])?;
    if v["payloadKinds"] != json!(["text", "binary"])
        || if selection {
            v["framing"].as_u64() != Some(2)
        } else {
            v["framing"]
                .as_array()
                .is_none_or(|a| a.len() != 1 || a[0].as_u64() != Some(2))
        }
    {
        return Err(Error::Invalid("capabilities"));
    }
    Ok(())
}
// Preserve exact-key validation even when a sender repeats the same JSON key.
fn strict_json(s: &str) -> Result<Value> {
    struct Unique(Value);
    impl<'de> Deserialize<'de> for Unique {
        fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
            struct Visitor;
            impl<'de> serde::de::Visitor<'de> for Visitor {
                type Value = Unique;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("JSON with unique object keys")
                }
                fn visit_map<M: serde::de::MapAccess<'de>>(
                    self,
                    mut m: M,
                ) -> std::result::Result<Unique, M::Error> {
                    let mut out = serde_json::Map::new();
                    while let Some((k, Unique(v))) = m.next_entry::<String, Unique>()? {
                        if out.insert(k, v).is_some() {
                            return Err(serde::de::Error::custom("duplicate key"));
                        }
                    }
                    Ok(Unique(Value::Object(out)))
                }
                fn visit_seq<A: serde::de::SeqAccess<'de>>(
                    self,
                    mut a: A,
                ) -> std::result::Result<Unique, A::Error> {
                    let mut out = Vec::new();
                    while let Some(Unique(v)) = a.next_element()? {
                        out.push(v)
                    }
                    Ok(Unique(Value::Array(out)))
                }
                fn visit_bool<E: serde::de::Error>(
                    self,
                    v: bool,
                ) -> std::result::Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Unique, E> {
                    Ok(Unique(json!(v)))
                }
                fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Unique, E> {
                    Ok(Unique(Value::Null))
                }
            }
            d.deserialize_any(Visitor)
        }
    }
    Ok(serde_json::from_str::<Unique>(s)?.0)
}
#[derive(Clone)]
pub struct Hello {
    pub client_public_key: [u8; 32],
    pub client_nonce: [u8; 32],
    pub context: Context,
}
impl Hello {
    pub fn parse(s: &str, expected: &Context) -> Result<Self> {
        let v = strict_json(s)?;
        exact(
            &v,
            &[
                "type",
                "v",
                "clientPublicKeyB64",
                "clientNonceB64",
                "capabilities",
                "context",
            ],
        )?;
        version(&v)?;
        if text(&v, "type")? != "e2ee_hello" {
            return Err(Error::Invalid("hello type"));
        }
        capabilities(&v["capabilities"], false)?;
        if v["context"] != serde_json::to_value(expected)? {
            return Err(Error::Invalid("context"));
        }
        let pk = b32(text(&v, "clientPublicKeyB64")?)?;
        let probe = x25519_dalek::StaticSecret::from([0x42; 32])
            .diffie_hellman(&x25519_dalek::PublicKey::from(pk));
        if !probe.was_contributory() {
            return Err(Error::Invalid("public key"));
        }
        Ok(Self {
            client_public_key: pk,
            client_nonce: b32(text(&v, "clientNonceB64")?)?,
            context: expected.clone(),
        })
    }
    pub fn ready(&self, pk: [u8; 32], nonce: [u8; 32]) -> Value {
        json!({"type":"e2ee_ready","v":2,"desktopPublicKeyB64":STANDARD.encode(pk),"clientNonceB64":STANDARD.encode(self.client_nonce),"desktopNonceB64":STANDARD.encode(nonce),"selection":{"framing":2,"payloadKinds":["text","binary"]},"context":self.context})
    }
}
pub fn validate_ready(s: &str, hello: &Hello, pinned: &[u8; 32]) -> Result<[u8; 32]> {
    let v = strict_json(s)?;
    exact(
        &v,
        &[
            "type",
            "v",
            "desktopPublicKeyB64",
            "clientNonceB64",
            "desktopNonceB64",
            "selection",
            "context",
        ],
    )?;
    version(&v)?;
    if text(&v, "type")? != "e2ee_ready" || v["context"] != serde_json::to_value(&hello.context)? {
        return Err(Error::Invalid("ready"));
    }
    capabilities(&v["selection"], true)?;
    if !eq(&b32(text(&v, "desktopPublicKeyB64")?)?, pinned)
        || !eq(&b32(text(&v, "clientNonceB64")?)?, &hello.client_nonce)
    {
        return Err(Error::Invalid("ready pin or nonce"));
    }
    b32(text(&v, "desktopNonceB64")?)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthError {
    BadAuth,
    Unauthorized,
    DeviceRevoked,
    RegistryUnavailable,
    BadProof,
}
impl AuthError {
    pub fn code(self) -> &'static str {
        match self {
            Self::BadAuth => "bad_auth",
            Self::Unauthorized => "unauthorized",
            Self::DeviceRevoked => "device_revoked",
            Self::RegistryUnavailable => "registry_unavailable",
            Self::BadProof => "bad_proof",
        }
    }
    pub fn close(self) -> Close {
        Close {
            code: 4001,
            reason: match self {
                Self::Unauthorized | Self::DeviceRevoked => "Unauthorized",
                Self::RegistryUnavailable => "Device registry unavailable",
                _ => "Invalid e2ee_auth",
            },
        }
    }
    pub fn message(self, device_id: Option<&str>) -> Value {
        let mut e = json!({"code":self.code()});
        if self == Self::DeviceRevoked {
            if let Some(id) = device_id {
                e["deviceId"] = json!(id)
            }
        }
        json!({"type":"e2ee_error","error":e})
    }
}
pub fn validate_auth(s: &str, hash: &[u8; 32]) -> std::result::Result<String, AuthError> {
    let parse = || -> Result<String> {
        let v = strict_json(s)?;
        exact(&v, &["type", "v", "transcriptHashB64", "deviceToken"])?;
        version(&v)?;
        if text(&v, "type")? != "e2ee_auth" {
            return Err(Error::Invalid("auth type"));
        }
        let h = b32(text(&v, "transcriptHashB64")?)?;
        if !eq(&h, hash) {
            return Err(Error::Protocol("bad_proof"));
        }
        let t = text(&v, "deviceToken")?;
        if t.is_empty() || t.len() > 65536 {
            return Err(Error::Invalid("device token"));
        }
        Ok(t.to_owned())
    };
    parse().map_err(|e| {
        if matches!(e, Error::Protocol("bad_proof")) {
            AuthError::BadProof
        } else {
            AuthError::BadAuth
        }
    })
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Close {
    pub code: u16,
    pub reason: &'static str,
}
impl Close {
    pub fn handshake_timeout() -> Self {
        Self {
            code: 4002,
            reason: "E2EE handshake timeout",
        }
    }
    pub fn outbound_overflow() -> Self {
        Self {
            code: 1013,
            reason: "Outbound reply buffer overflow",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WireMessage {
    Text(String),
    Binary(Vec<u8>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Send(WireMessage),
    Payload { kind: Kind, bytes: Vec<u8> },
    Close(Close),
}
#[derive(PartialEq, Eq)]
enum Phase {
    Hello,
    Auth,
    Ready,
    Closed,
}
/// The responder's answer to a plaintext hello: the plaintext ready message
/// and the framer of the session it opens. For listeners that run their own
/// socket loop; `Responder` uses the same step.
pub fn answer_hello(host: &HostKey, context: &Context, hello: &str) -> Result<(String, Framer)> {
    let hello = Hello::parse(hello, context)?;
    let mut dn = [0; 32];
    OsRng.fill_bytes(&mut dn);
    let shared = host.shared(hello.client_public_key)?;
    let pk = host.public_key();
    let tr = transcript(
        context,
        &hello.client_public_key,
        &hello.client_nonce,
        &pk,
        &dn,
    );
    let keys = SessionKeys::derive(shared, &hello.client_nonce, &dn, &tr);
    Ok((hello.ready(pk, dn).to_string(), Framer::responder(keys)))
}
/// A refused `e2ee_auth`: send the sealed error frame (as text), then close
/// with `error.close()`.
#[derive(Debug)]
pub struct AuthRefusal {
    pub error: AuthError,
    pub sealed_reply: Vec<u8>,
}
/// An accepted `e2ee_auth`: who the device is, the token it presented (every
/// later request must carry it), and the sealed `e2ee_authenticated` reply to
/// send (as text).
#[derive(Debug)]
pub struct Accepted {
    pub credential: Credential,
    pub device_token: String,
    pub sealed_reply: Vec<u8>,
}
/// Open the first sealed text frame of a session as `e2ee_auth`, check its
/// transcript proof and authenticate its token. `framer` must be fresh from
/// `answer_hello`.
pub fn accept_auth(
    framer: &mut Framer,
    frame: &[u8],
    now: u64,
    registry: &mut Registry,
) -> std::result::Result<Accepted, AuthRefusal> {
    fn seal(framer: &mut Framer, message: &str) -> Vec<u8> {
        framer
            .seal(Kind::Text, message.as_bytes())
            .expect("the first frame of a session always seals")
    }
    let refuse = |framer: &mut Framer, error: AuthError| AuthRefusal {
        error,
        sealed_reply: seal(framer, &error.message(None).to_string()),
    };
    let token = match framer
        .open(Kind::Text, frame)
        .map_err(|_| AuthError::BadAuth)
        .and_then(|p| String::from_utf8(p).map_err(|_| AuthError::BadAuth))
        .and_then(|s| validate_auth(&s, &framer.transcript_hash()))
    {
        Ok(t) => t,
        Err(e) => return Err(refuse(framer, e)),
    };
    let credential = match registry.authenticate(&token, now) {
        Ok(c) => c,
        Err(Error::Protocol(_)) => return Err(refuse(framer, AuthError::Unauthorized)),
        Err(_) => return Err(refuse(framer, AuthError::RegistryUnavailable)),
    };
    let reply = json!({"type":"e2ee_authenticated","v":2,"transcriptHashB64":STANDARD.encode(framer.transcript_hash())});
    Ok(Accepted {
        credential,
        device_token: token,
        sealed_reply: seal(framer, &reply.to_string()),
    })
}
pub struct Responder {
    host: HostKey,
    context: Context,
    started: u64,
    phase: Phase,
    framer: Option<Framer>,
    credential: Option<Credential>,
    failures: u8,
}
impl Responder {
    pub fn new(host: HostKey, context: Context, connected_at_ms: u64) -> Self {
        Self {
            host,
            context,
            started: connected_at_ms,
            phase: Phase::Hello,
            framer: None,
            credential: None,
            failures: 0,
        }
    }
    pub fn credential(&self) -> Option<&Credential> {
        self.credential.as_ref()
    }
    fn close(&mut self, c: Close) -> Vec<Action> {
        self.phase = Phase::Closed;
        vec![Action::Close(c)]
    }
    pub fn tick(&mut self, now: u64) -> Vec<Action> {
        if matches!(self.phase, Phase::Hello | Phase::Auth)
            && now.saturating_sub(self.started) >= HANDSHAKE_TIMEOUT_MS
        {
            self.close(Close::handshake_timeout())
        } else {
            Vec::new()
        }
    }
    fn wire(&mut self, k: Kind, p: &[u8]) -> Result<WireMessage> {
        let f = self
            .framer
            .as_mut()
            .ok_or(Error::Invalid("handshake state"))?
            .seal(k, p)?;
        Ok(match k {
            Kind::Text => WireMessage::Text(STANDARD.encode(f)),
            Kind::Binary => WireMessage::Binary(f),
        })
    }
    pub fn send(&mut self, k: Kind, p: &[u8]) -> Result<WireMessage> {
        if self.phase != Phase::Ready {
            return Err(Error::Invalid("not authenticated"));
        }
        self.wire(k, p)
    }
    fn auth_failure(&mut self, e: AuthError) -> Vec<Action> {
        let mut actions = Vec::new();
        let msg = e
            .message(self.credential.as_ref().map(|c| c.device_id.as_str()))
            .to_string();
        if let Ok(w) = self.wire(Kind::Text, msg.as_bytes()) {
            actions.push(Action::Send(w))
        }
        actions.extend(self.close(e.close()));
        actions
    }
    pub fn receive(
        &mut self,
        message: WireMessage,
        now: u64,
        registry: &mut Registry,
    ) -> Vec<Action> {
        let expired = self.tick(now);
        if !expired.is_empty() {
            return expired;
        }
        if self.phase == Phase::Closed {
            return Vec::new();
        }
        let size = match &message {
            WireMessage::Text(s) => s.len(),
            WireMessage::Binary(b) => b.len(),
        };
        if size > MAX_INBOUND_BYTES {
            return self.close(Close {
                code: 1009,
                reason: "Message too large",
            });
        }
        if self.phase == Phase::Hello {
            let WireMessage::Text(s) = message else {
                return self.close(Close {
                    code: 4001,
                    reason: "Invalid handshake message",
                });
            };
            return match answer_hello(&self.host, &self.context, &s) {
                Ok((ready, framer)) => {
                    self.framer = Some(framer);
                    self.phase = Phase::Auth;
                    vec![Action::Send(WireMessage::Text(ready))]
                }
                Err(_) => self.close(Close {
                    code: 4001,
                    reason: "Invalid handshake message",
                }),
            };
        }
        if self.phase == Phase::Ready {
            let c = self.credential.as_ref().unwrap();
            if let Err(e) = registry.check(c, now) {
                return self.auth_failure(match e {
                    Error::Protocol(_) => AuthError::DeviceRevoked,
                    _ => AuthError::RegistryUnavailable,
                });
            }
        }
        let (kind, frame) = match message {
            WireMessage::Text(s) => (Kind::Text, b64(&s)),
            WireMessage::Binary(b) => (Kind::Binary, Ok(b)),
        };
        if self.phase == Phase::Auth {
            let frame = match (kind, frame) {
                (Kind::Text, Ok(f)) => f,
                _ => return self.auth_failure(AuthError::BadAuth),
            };
            return match accept_auth(self.framer.as_mut().unwrap(), &frame, now, registry) {
                Ok(accepted) => {
                    self.credential = Some(accepted.credential);
                    self.phase = Phase::Ready;
                    vec![Action::Send(WireMessage::Text(
                        STANDARD.encode(accepted.sealed_reply),
                    ))]
                }
                Err(refusal) => {
                    let mut actions = vec![Action::Send(WireMessage::Text(
                        STANDARD.encode(refusal.sealed_reply),
                    ))];
                    actions.extend(self.close(refusal.error.close()));
                    actions
                }
            };
        }
        let payload = frame.and_then(|f| self.framer.as_mut().unwrap().open(kind, &f));
        let payload = match payload {
            Ok(p) => {
                self.failures = 0;
                p
            }
            Err(_) => {
                self.failures += 1;
                return if self.failures >= MAX_DECRYPTION_FAILURES {
                    self.close(Close {
                        code: 4003,
                        reason: "Too many decryption failures",
                    })
                } else {
                    Vec::new()
                };
            }
        };
        if kind == Kind::Text && std::str::from_utf8(&payload).is_err() {
            return self.close(Close {
                code: 4001,
                reason: "Invalid text payload",
            });
        }
        vec![Action::Payload {
            kind,
            bytes: payload,
        }]
    }
}
