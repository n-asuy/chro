//! Wire contract of the chro operator API: the only surface the `chro` CLI
//! uses, versioned under `/v1`, separate from the internal `/rpc` API the app's
//! own UI talks to.
//!
//! The server and the CLI both depend on this crate and on nothing else of
//! each other, so the contract is the boundary between them.

pub mod api;
mod envelope;
mod error;
pub mod routes;
pub mod runtime_file;

pub use envelope::{Envelope, Meta};
pub use error::{ErrorBody, ErrorCode};

/// Revision of this contract: the crate version plus a digest of its source.
/// A client and a server talk only when their revisions are equal.
pub const CONTRACT_REV: &str = env!("CHRO_CONTRACT_REV");

#[cfg(test)]
mod tests {
    #[test]
    fn revision_is_version_plus_digest() {
        let (version, digest) = super::CONTRACT_REV.split_once('+').unwrap();
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
        assert_eq!(digest.len(), 8);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
