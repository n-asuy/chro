//! Operating the machine a chro server runs on.
//!
//! This is not an agent. It answers the questions a control plane has to ask
//! before it can safely stop or bill a machine: is the server healthy, is work
//! in progress, when was the user last active.
//!
//! It is a separate process from the chro server on purpose. The moment those
//! answers matter most is when the server itself is wedged, and a health check
//! that dies with the thing it is checking reports nothing at all.

pub mod health;
pub mod quiesce;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

/// What the control plane may ask of an instance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OpsState {
    /// The server answers and nothing is being held still.
    Running,
    /// Writes have been stopped so the disk can be captured or the machine
    /// powered down.
    Quiesced,
    /// The server did not answer.
    ServerDown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthReport {
    pub state: OpsState,
    /// Whether the chro server answered its own health check.
    pub server_healthy: bool,
    /// Milliseconds since the epoch of the last request the server served, when
    /// it could be read.
    pub last_activity_ms: Option<i64>,
    pub disk_free_bytes: Option<u64>,
    pub memory_available_bytes: Option<u64>,
}

/// Whether the machine is currently held still.
///
/// Kept as shared state rather than derived from the server, because the point
/// of quiescing is to be able to answer even when the server is unresponsive.
#[derive(Clone, Default)]
pub struct Quiesced(Arc<AtomicBool>);

impl Quiesced {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn set(&self, value: bool) {
        self.0.store(value, Ordering::SeqCst);
    }
}
