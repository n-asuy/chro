//! The [`DeviceLink`] of a running server, on the pairing and encryption
//! library.
//!
//! The host key and the device registry live in one directory per server
//! (next to its database), so a second server on another database pairs its
//! own phones with its own key. Every registry access goes through one lock,
//! as the library requires. The calls may read and fsync files, so the
//! listener and the routes make them off the async workers.

use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use mobile_link::{
    accept_auth, answer_hello, Context, Credential, Device, Error as LibraryError, Framer, HostKey,
    Kind, Offers, Registry,
};
use uuid::Uuid;

use super::{
    link::{
        Authenticated, DeviceGrant, DeviceLink, FrameKind, IssuedOffer, LinkError, OpenError,
        PairedDevice, Rejection, Responder, SecureChannel, SourceClass, Standing, TicketError,
    },
    listener::CLOSE_INVALID,
};

/// The host's X25519 key pair.
pub(crate) const HOST_KEY_FILE: &str = "e2ee-keypair.json";
/// Paired devices and unscanned offers.
pub(crate) const REGISTRY_FILE: &str = "devices.json";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// What an offer names the device until the phone reports its own name.
fn offer_device_name() -> String {
    format!("Mobile {}", chrono::Local::now().format("%-m/%-d/%Y"))
}

fn library_kind(kind: FrameKind) -> Kind {
    match kind {
        FrameKind::Text => Kind::Text,
        FrameKind::Binary => Kind::Binary,
    }
}

fn credential(grant: &DeviceGrant) -> Credential {
    Credential::for_token(&grant.device_id.to_string(), grant.revision, &grant.token)
}

struct Store {
    registry: Registry,
    offers: Offers,
}

#[derive(Clone)]
pub(crate) struct DiskLink {
    host: HostKey,
    store: Arc<Mutex<Store>>,
}

impl DiskLink {
    /// Load the host key and registry in `dir`, creating the key on first
    /// use. A key that exists but cannot be read is an error, never replaced:
    /// a new key would unpair every phone.
    pub(crate) fn open(dir: &Path) -> Result<Self, LinkError> {
        let key_path = dir.join(HOST_KEY_FILE);
        let host = HostKey::load_or_generate(&key_path)
            .map_err(|err| LinkError(format!("host key {}: {err}", key_path.display())))?;
        let registry_path = dir.join(REGISTRY_FILE);
        let registry = Registry::open(&registry_path).map_err(|err| {
            LinkError(format!(
                "device registry {}: {err}",
                registry_path.display()
            ))
        })?;
        Ok(Self {
            host,
            store: Arc::new(Mutex::new(Store {
                registry,
                offers: Offers::default(),
            })),
        })
    }

    #[cfg(test)]
    pub(crate) fn public_key(&self) -> [u8; 32] {
        self.host.public_key()
    }

    fn store(&self) -> MutexGuard<'_, Store> {
        lock(&self.store)
    }
}

fn lock(store: &Mutex<Store>) -> MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The wire code and message of a refused ticket exchange.
fn ticket_error(err: LibraryError) -> TicketError {
    let (code, message) = match err {
        // The connection's credential no longer holds: its row is gone or
        // was rotated under it.
        LibraryError::Protocol("device_revoked") => {
            ("device_not_found", "this device is no longer paired")
        }
        LibraryError::Protocol("invalid_argument") => (
            "invalid_argument",
            "deviceToken must be 48 to 128 lowercase hex characters",
        ),
        LibraryError::Protocol("not_a_ticket") => (
            "not_a_ticket",
            "only a connection opened with the QR ticket can exchange it",
        ),
        LibraryError::Protocol("ticket_window_closed") => (
            "ticket_window_closed",
            "the ticket can only be exchanged within 10 minutes of its first use",
        ),
        LibraryError::Protocol("ticket_exchange_pending") => (
            "ticket_exchange_pending",
            "the ticket is already being exchanged for another token",
        ),
        LibraryError::Protocol("device_token_in_use") => (
            "device_token_in_use",
            "that token belongs to another device",
        ),
        other => {
            return TicketError {
                code: "internal",
                message: other.to_string(),
            }
        }
    };
    TicketError {
        code,
        message: message.to_string(),
    }
}

fn registry_error(err: LibraryError) -> LinkError {
    LinkError(err.to_string())
}

impl DeviceLink for DiskLink {
    fn responder(&self) -> Box<dyn Responder> {
        Box::new(Handshake {
            host: self.host.clone(),
            store: Arc::clone(&self.store),
            framer: None,
        })
    }

    fn standing(&self, grant: &DeviceGrant) -> Standing {
        match self.store().registry.check(&credential(grant), now_ms()) {
            Ok(()) => Standing::Active,
            Err(LibraryError::Protocol(_)) => Standing::Revoked,
            Err(err) => {
                // Fail closed: a registry that cannot be read admits nobody.
                tracing::warn!(device = %grant.device_id, error = %err, "could not read the device registry");
                Standing::Revoked
            }
        }
    }

    fn exchange_ticket(&self, grant: &DeviceGrant, new_token: &str) -> Result<Uuid, TicketError> {
        let device_id = self
            .store()
            .registry
            .exchange_ticket(&credential(grant), new_token, now_ms())
            .map_err(ticket_error)?;
        Uuid::parse_str(&device_id).map_err(|err| TicketError {
            code: "internal",
            message: format!("the registry holds a malformed device id: {err}"),
        })
    }

    fn issue_offer(&self, endpoint: &str, rotate: bool) -> Result<IssuedOffer, LinkError> {
        let mut store = self.store();
        let Store { registry, offers } = &mut *store;
        let issued = offers
            .issue(
                registry,
                &self.host,
                endpoint,
                &offer_device_name(),
                now_ms(),
                rotate,
            )
            .map_err(registry_error)?;
        Ok(IssuedOffer {
            pairing_url: issued.pairing_url,
            qr_svg: issued.qr_svg,
            expires_at: issued.expires_at,
        })
    }

    fn devices(&self) -> Result<Vec<PairedDevice>, LinkError> {
        Ok(self
            .store()
            .registry
            .devices()
            .iter()
            .filter_map(paired_device)
            .collect())
    }

    fn revoke(&self, device_id: Uuid) -> Result<bool, LinkError> {
        self.store()
            .registry
            .revoke(&device_id.to_string())
            .map_err(registry_error)
    }
}

/// A row as the desktop lists it: only devices that authenticated at least
/// once, so unscanned offers stay out of the list.
fn paired_device(row: &Device) -> Option<PairedDevice> {
    let last_seen_at = row.last_seen_at?;
    let id = match Uuid::parse_str(&row.id) {
        Ok(id) => id,
        Err(err) => {
            tracing::warn!(id = %row.id, error = %err, "skipping a device row with a malformed id");
            return None;
        }
    };
    Some(PairedDevice {
        id,
        name: row.name.clone(),
        paired_at: row.paired_at,
        last_seen_at: Some(last_seen_at),
        last_source: row.last_source.as_deref().and_then(SourceClass::parse),
    })
}

struct Handshake {
    host: HostKey,
    store: Arc<Mutex<Store>>,
    framer: Option<Framer>,
}

impl Responder for Handshake {
    fn hello(&mut self, hello: &str) -> Result<String, Rejection> {
        let (ready, framer) = answer_hello(&self.host, &Context::direct(), hello)
            .map_err(|_| Rejection::new(CLOSE_INVALID, "Invalid handshake message"))?;
        self.framer = Some(framer);
        Ok(ready)
    }

    fn authenticate(
        self: Box<Self>,
        frame: &[u8],
        source: SourceClass,
    ) -> Result<Authenticated, Rejection> {
        let Some(mut framer) = self.framer else {
            return Err(Rejection::new(CLOSE_INVALID, "Invalid handshake message"));
        };
        let mut store = lock(&self.store);
        let accepted =
            accept_auth(&mut framer, frame, now_ms(), &mut store.registry).map_err(|refusal| {
                let close = refusal.error.close();
                Rejection {
                    sealed_reply: Some(refusal.sealed_reply),
                    close_code: close.code,
                    close_reason: close.reason.to_string(),
                }
            })?;
        let credential = accepted.credential;
        if let Err(err) = store
            .registry
            .record_source(&credential, source.as_str(), now_ms())
        {
            tracing::warn!(device = %credential.device_id, error = %err, "could not record where a phone connected from");
        }
        let is_ticket = store
            .registry
            .devices()
            .iter()
            .any(|row| row.id == credential.device_id && row.is_ticket());
        drop(store);
        let device_id = Uuid::parse_str(&credential.device_id)
            .map_err(|_| Rejection::new(CLOSE_INVALID, "Device registry unavailable"))?;
        Ok(Authenticated {
            channel: Box::new(Channel(framer)),
            grant: DeviceGrant {
                device_id,
                token: accepted.device_token,
                revision: credential.revision,
                is_ticket,
            },
            sealed_reply: accepted.sealed_reply,
        })
    }
}

struct Channel(Framer);

impl SecureChannel for Channel {
    fn open(&mut self, kind: FrameKind, frame: &[u8]) -> Result<Vec<u8>, OpenError> {
        self.0
            .open(library_kind(kind), frame)
            .map_err(|err| OpenError(err.to_string()))
    }

    fn seal(&mut self, kind: FrameKind, payload: &[u8]) -> Vec<u8> {
        self.0
            .seal(library_kind(kind), payload)
            .expect("a 64-bit frame counter outlasts any connection")
    }
}
