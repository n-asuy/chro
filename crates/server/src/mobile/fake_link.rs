//! An in-memory [`DeviceLink`] for tests.
//!
//! The handshake is `hello` → `ready`, then the device's token as the first
//! sealed frame. "Sealing" prefixes `direction ‖ kind ‖ u64be(counter)` and
//! opening insists on the expected direction, kind and counter, so replays,
//! gaps, reflections and kind mix-ups fail as they would with real keys. The
//! peer side of the same scheme is [`FakePhoneChannel`].

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use chrono::Utc;
use uuid::Uuid;

use super::link::{
    Authenticated, DeviceGrant, DeviceLink, FrameKind, IssuedOffer, LinkError, OpenError,
    PairedDevice, Rejection, Responder, SecureChannel, SourceClass, Standing, TicketError,
};

fn now_ms() -> u64 {
    Utc::now().timestamp_millis().unsigned_abs()
}

const PHONE_TO_HOST: u8 = 0;
const HOST_TO_PHONE: u8 = 1;

fn kind_byte(kind: FrameKind) -> u8 {
    match kind {
        FrameKind::Text => 0,
        FrameKind::Binary => 1,
    }
}

fn seal(direction: u8, kind: FrameKind, counter: u64, payload: &[u8]) -> Vec<u8> {
    let mut frame = vec![direction, kind_byte(kind)];
    frame.extend_from_slice(&counter.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

fn open(direction: u8, kind: FrameKind, counter: u64, frame: &[u8]) -> Result<Vec<u8>, OpenError> {
    if frame.len() < 10 {
        return Err(OpenError("short frame".into()));
    }
    if frame[0] != direction || frame[1] != kind_byte(kind) {
        return Err(OpenError("wrong direction or kind".into()));
    }
    if u64::from_be_bytes(frame[2..10].try_into().unwrap()) != counter {
        return Err(OpenError("unexpected counter".into()));
    }
    Ok(frame[10..].to_vec())
}

/// Counters of one side, shared by text and binary like the real framing.
#[derive(Default)]
struct Counters {
    send: u64,
    receive: u64,
}

struct HostChannel {
    counters: Counters,
}

impl SecureChannel for HostChannel {
    fn open(&mut self, kind: FrameKind, frame: &[u8]) -> Result<Vec<u8>, OpenError> {
        let plaintext = open(PHONE_TO_HOST, kind, self.counters.receive, frame)?;
        self.counters.receive += 1;
        Ok(plaintext)
    }

    fn seal(&mut self, kind: FrameKind, payload: &[u8]) -> Vec<u8> {
        let frame = seal(HOST_TO_PHONE, kind, self.counters.send, payload);
        self.counters.send += 1;
        frame
    }
}

/// The phone's side of the fake encryption, for test clients.
#[derive(Default)]
pub(crate) struct FakePhoneChannel {
    counters: Counters,
}

impl FakePhoneChannel {
    pub(crate) fn seal(&mut self, kind: FrameKind, payload: &[u8]) -> Vec<u8> {
        let frame = seal(PHONE_TO_HOST, kind, self.counters.send, payload);
        self.counters.send += 1;
        frame
    }

    pub(crate) fn open(&mut self, kind: FrameKind, frame: &[u8]) -> Result<Vec<u8>, OpenError> {
        let plaintext = open(HOST_TO_PHONE, kind, self.counters.receive, frame)?;
        self.counters.receive += 1;
        Ok(plaintext)
    }
}

#[derive(Debug, Clone)]
struct FakeDevice {
    token: String,
    is_ticket: bool,
    name: String,
    last_source: Option<SourceClass>,
}

#[derive(Default)]
struct Registry {
    devices: HashMap<Uuid, FakeDevice>,
    offers: Vec<(String, bool)>,
}

#[derive(Clone, Default)]
pub(crate) struct FakeLink {
    registry: Arc<Mutex<Registry>>,
}

impl FakeLink {
    /// Register a paired device holding `token`.
    pub(crate) fn pair(&self, token: &str, is_ticket: bool) -> Uuid {
        let id = Uuid::new_v4();
        self.registry.lock().unwrap().devices.insert(
            id,
            FakeDevice {
                token: token.to_string(),
                is_ticket,
                name: "Test phone".into(),
                last_source: None,
            },
        );
        id
    }

    pub(crate) fn pair_from(&self, token: &str, source: SourceClass) -> Uuid {
        let id = self.pair(token, false);
        self.registry
            .lock()
            .unwrap()
            .devices
            .get_mut(&id)
            .unwrap()
            .last_source = Some(source);
        id
    }

    /// Change a device's token behind its connections' backs.
    pub(crate) fn rotate_token(&self, device_id: Uuid, token: &str) {
        self.registry
            .lock()
            .unwrap()
            .devices
            .get_mut(&device_id)
            .unwrap()
            .token = token.to_string();
    }

    pub(crate) fn token_of(&self, device_id: Uuid) -> Option<String> {
        self.registry
            .lock()
            .unwrap()
            .devices
            .get(&device_id)
            .map(|device| device.token.clone())
    }

    pub(crate) fn last_source(&self, device_id: Uuid) -> Option<SourceClass> {
        self.registry
            .lock()
            .unwrap()
            .devices
            .get(&device_id)
            .and_then(|device| device.last_source)
    }

    /// `(endpoint, rotate)` of every offer issued.
    pub(crate) fn offers(&self) -> Vec<(String, bool)> {
        self.registry.lock().unwrap().offers.clone()
    }
}

struct FakeResponder {
    registry: Arc<Mutex<Registry>>,
    greeted: bool,
}

impl Responder for FakeResponder {
    fn hello(&mut self, hello: &str) -> Result<String, Rejection> {
        if hello != "hello" {
            return Err(Rejection::new(4001, "Invalid handshake message"));
        }
        self.greeted = true;
        Ok("ready".into())
    }

    fn authenticate(
        self: Box<Self>,
        frame: &[u8],
        source: SourceClass,
    ) -> Result<Authenticated, Rejection> {
        assert!(self.greeted, "authenticate before hello");
        let mut channel = HostChannel {
            counters: Counters::default(),
        };
        let token = match channel.open(FrameKind::Text, frame) {
            Ok(token) => String::from_utf8(token).unwrap_or_default(),
            Err(_) => return Err(Rejection::new(4001, "Invalid e2ee_auth")),
        };
        let mut registry = self.registry.lock().unwrap();
        let found = registry
            .devices
            .iter_mut()
            .find(|(_, device)| device.token == token);
        match found {
            Some((id, device)) => {
                device.last_source = Some(source);
                let grant = DeviceGrant {
                    device_id: *id,
                    token,
                    revision: 1,
                    is_ticket: device.is_ticket,
                };
                let sealed_reply = channel.seal(FrameKind::Text, b"authenticated");
                Ok(Authenticated {
                    channel: Box::new(channel),
                    grant,
                    sealed_reply,
                })
            }
            None => Err(Rejection {
                sealed_reply: Some(channel.seal(FrameKind::Text, b"unauthorized")),
                close_code: 4001,
                close_reason: "Unauthorized".into(),
            }),
        }
    }
}

impl DeviceLink for FakeLink {
    fn responder(&self) -> Box<dyn Responder> {
        Box::new(FakeResponder {
            registry: Arc::clone(&self.registry),
            greeted: false,
        })
    }

    fn standing(&self, grant: &DeviceGrant) -> Standing {
        match self.registry.lock().unwrap().devices.get(&grant.device_id) {
            Some(device) if device.token == grant.token => Standing::Active,
            // After a ticket exchange the old ticket socket stays valid until
            // the device authenticates with its new token.
            Some(device) if grant.is_ticket && !device.is_ticket => Standing::Active,
            _ => Standing::Revoked,
        }
    }

    fn exchange_ticket(&self, grant: &DeviceGrant, new_token: &str) -> Result<Uuid, TicketError> {
        let mut registry = self.registry.lock().unwrap();
        let in_use = registry
            .devices
            .iter()
            .any(|(id, device)| *id != grant.device_id && device.token == new_token);
        if in_use {
            return Err(TicketError {
                code: "device_token_in_use",
                message: "that token belongs to another device".into(),
            });
        }
        let device = registry
            .devices
            .get_mut(&grant.device_id)
            .ok_or_else(|| TicketError {
                code: "device_not_found",
                message: "no such device".into(),
            })?;
        if !device.is_ticket && device.token != new_token {
            return Err(TicketError {
                code: "ticket_already_exchanged",
                message: "the ticket was exchanged for another token".into(),
            });
        }
        device.token = new_token.to_string();
        device.is_ticket = false;
        Ok(grant.device_id)
    }

    fn issue_offer(&self, endpoint: &str, rotate: bool) -> Result<IssuedOffer, LinkError> {
        self.registry
            .lock()
            .unwrap()
            .offers
            .push((endpoint.to_string(), rotate));
        Ok(IssuedOffer {
            pairing_url: format!("chro://pair?code={endpoint}"),
            qr_svg: "<svg/>".into(),
            expires_at: now_ms() + 10 * 60 * 1000,
        })
    }

    fn devices(&self) -> Result<Vec<PairedDevice>, LinkError> {
        Ok(self
            .registry
            .lock()
            .unwrap()
            .devices
            .iter()
            .map(|(id, device)| PairedDevice {
                id: *id,
                name: device.name.clone(),
                paired_at: now_ms(),
                last_seen_at: device.last_source.map(|_| now_ms()),
                last_source: device.last_source,
            })
            .collect())
    }

    fn revoke(&self, device_id: Uuid) -> Result<bool, LinkError> {
        Ok(self
            .registry
            .lock()
            .unwrap()
            .devices
            .remove(&device_id)
            .is_some())
    }
}
