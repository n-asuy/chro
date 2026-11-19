//! Pure, synchronous mobile responder; no sockets, runtime, or wall clock.
//!
//! `HostKey::load_or_generate(path)` persists the host identity. `Registry::open`
//! loads credentials; `Offers::issue` returns an offer, URL, expiry and SVG.
//! `Responder::new` pins the listener's `Context` and connection time (milliseconds).
//! Feed WebSocket messages to `receive(WireMessage, now_ms, &mut Registry)`.
//! Apply returned `Action`s in order: send messages, deliver authenticated payloads,
//! then close if requested. Call `tick` for the handshake deadline. Call `send`
//! only in actual send order, after accepting the payload into the listener queue.
//! Every incoming ready-state frame rechecks the registry on disk and credential
//! revision. Serialize registry access and all calls on each responder externally.
//! Ticket exchange uses the authenticated `Credential` from `credential()` and
//! `Registry::exchange_ticket(credential, new_device_token, now_ms)`; the RPC params
//! are `{deviceToken: new_device_token}`. New-token authentication commits rotation.
//! `SessionKeys` / `Framer` are low-level interop APIs; applications use `Responder`.
mod crypto;
mod handshake;
mod storage;
use base64::{engine::general_purpose::STANDARD, Engine};
pub use crypto::*;
pub use handshake::*;
pub use storage::*;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("storage: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid {0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Protocol(&'static str),
}
pub type Result<T> = std::result::Result<T, Error>;
pub(crate) fn b64(s: &str) -> Result<Vec<u8>> {
    let b = STANDARD.decode(s).map_err(|_| Error::Invalid("base64"))?;
    if STANDARD.encode(&b) != s {
        return Err(Error::Invalid("canonical base64"));
    }
    Ok(b)
}
pub(crate) fn b32(s: &str) -> Result<[u8; 32]> {
    b64(s)?
        .try_into()
        .map_err(|_| Error::Invalid("32-byte base64"))
}
pub(crate) fn eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |v, (x, y)| v | (x ^ y)) == 0
}
