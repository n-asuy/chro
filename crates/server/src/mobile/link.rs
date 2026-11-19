//! What the phone listener needs from the pairing and encryption library.
//!
//! The library owns the host key, offers and their QR codes, the device
//! registry, and the responder side of the end-to-end encrypted handshake and
//! framing. The listener owns sockets, limits and dispatch. This trait is the
//! seam between them, so the listener is tested against an in-memory fake and
//! the library can be swapped in behind it.
//!
//! Text frames travel over the WebSocket as standard base64 of the sealed
//! bytes; binary frames as the raw sealed bytes. The listener does that
//! encoding, so every method here sees raw bytes.

use std::fmt;

use uuid::Uuid;

/// The two frame kinds of the encrypted link. Each has its own nonce domain,
/// and the receiver takes the kind from the WebSocket opcode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FrameKind {
    Text,
    Binary,
}

/// Where a connection came from, as recorded on the device's row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SourceClass {
    Loopback,
    Private,
    Tailnet,
    /// Outside the private ranges, but on a subnet of one of this machine's
    /// interfaces.
    SameLink,
}

impl SourceClass {
    const ALL: [SourceClass; 4] = [
        SourceClass::Loopback,
        SourceClass::Private,
        SourceClass::Tailnet,
        SourceClass::SameLink,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            SourceClass::Loopback => "loopback",
            SourceClass::Private => "private",
            SourceClass::Tailnet => "tailnet",
            SourceClass::SameLink => "same-link",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|class| class.as_str() == value)
    }
}

/// The device a connection authenticated as, and the credential it used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeviceGrant {
    pub device_id: Uuid,
    /// The token the device authenticated with. Every request envelope must
    /// carry the same value.
    pub token: String,
    /// The credential revision the token authenticated at. A ticket exchange
    /// completes by bumping it, which ends connections still on the ticket.
    pub revision: u64,
    /// True while the token is still the QR ticket, so the connection may
    /// exchange it for a device-chosen token.
    pub is_ticket: bool,
}

/// Whether a connection may keep talking, rechecked on every frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Standing {
    Active,
    /// The device was removed, or its credential changed under this
    /// connection.
    Revoked,
}

/// A rejected handshake: what to send before closing, and how to close.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rejection {
    /// A sealed error frame to send (as text) before closing, when the
    /// handshake got far enough to have keys.
    pub sealed_reply: Option<Vec<u8>>,
    pub close_code: u16,
    pub close_reason: String,
}

impl Rejection {
    pub(crate) fn new(close_code: u16, close_reason: impl Into<String>) -> Self {
        Self {
            sealed_reply: None,
            close_code,
            close_reason: close_reason.into(),
        }
    }
}

/// An authenticated connection's keys and identity.
pub(crate) struct Authenticated {
    pub channel: Box<dyn SecureChannel>,
    pub grant: DeviceGrant,
    /// The sealed `e2ee_authenticated` frame to send (as text).
    pub sealed_reply: Vec<u8>,
}

/// The responder side of one connection's handshake.
pub(crate) trait Responder: Send {
    /// Answer the plaintext hello with the plaintext ready message.
    fn hello(&mut self, hello: &str) -> Result<String, Rejection>;

    /// Authenticate with the first sealed text frame.
    fn authenticate(
        self: Box<Self>,
        frame: &[u8],
        source: SourceClass,
    ) -> Result<Authenticated, Rejection>;
}

/// Why a frame could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpenError(pub String);

/// The keys and counters of one authenticated connection. Frames must be
/// sealed in the order they are sent and opened in the order they arrive.
pub(crate) trait SecureChannel: Send {
    fn open(&mut self, kind: FrameKind, frame: &[u8]) -> Result<Vec<u8>, OpenError>;
    fn seal(&mut self, kind: FrameKind, payload: &[u8]) -> Vec<u8>;
}

/// A ticket exchange refused by the registry, with the wire error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TicketError {
    /// One of `device_not_found`, `not_a_ticket`, `ticket_already_exchanged`,
    /// `ticket_exchange_pending`, `ticket_window_closed`,
    /// `device_token_in_use`, `invalid_argument`.
    pub code: &'static str,
    pub message: String,
}

/// A freshly issued pairing offer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IssuedOffer {
    /// `chro://pair?code=...`
    pub pairing_url: String,
    /// The pairing URL as a QR code, as an SVG document.
    pub qr_svg: String,
    /// Epoch milliseconds.
    pub expires_at: u64,
}

/// A paired device as the desktop lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PairedDevice {
    pub id: Uuid,
    pub name: String,
    /// Epoch milliseconds, as are the other times here.
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
    /// Where the device last connected from, if it ever did.
    pub last_source: Option<SourceClass>,
}

/// The registry could not be read or written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LinkError(pub String);

impl fmt::Display for LinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LinkError {}

/// The pairing and encryption library, as the server uses it.
pub(crate) trait DeviceLink: Send + Sync + 'static {
    /// Start the responder for a new direct connection.
    fn responder(&self) -> Box<dyn Responder>;

    /// Whether `grant` may still talk. Called on every received frame.
    fn standing(&self, grant: &DeviceGrant) -> Standing;

    /// Replace the QR ticket a connection authenticated with by a token the
    /// device chose. Persisted before it returns. Repeating the same
    /// exchange succeeds again.
    fn exchange_ticket(&self, grant: &DeviceGrant, new_token: &str) -> Result<Uuid, TicketError>;

    /// Issue an offer for `endpoint` (`ws://host:port`), reusing an unscanned
    /// one unless `rotate`.
    fn issue_offer(&self, endpoint: &str, rotate: bool) -> Result<IssuedOffer, LinkError>;

    /// Devices that completed pairing: unscanned offers are not listed.
    fn devices(&self) -> Result<Vec<PairedDevice>, LinkError>;

    /// Remove a device, on disk first. `Ok(false)` when there is no such
    /// device.
    fn revoke(&self, device_id: Uuid) -> Result<bool, LinkError>;
}
