//! This server process's identity as clients see it: a fresh runtime id, the
//! owner token that opens the operator API, and the `runtime.json` that
//! publishes both next to the database.

use std::path::{Path, PathBuf};

use chrono::Utc;
use server_contract::{
    runtime_file::{self, RuntimeFile},
    CONTRACT_REV,
};
use uuid::Uuid;

/// Environment variable naming the runtime file of the server an agent was
/// started by, so `chro` inside a session talks to that server even when
/// several run on one machine.
pub(crate) const RUNTIME_FILE_ENV: &str = "CHRO_RUNTIME_FILE";

/// Pins the owner token instead of generating one, for servers whose clients
/// are configured out of band (a control plane hands the same value to its
/// CLI as `CHRO_API_TOKEN`).
const OWNER_TOKEN_ENV: &str = "CHRO_OWNER_TOKEN";

#[derive(Debug, Clone)]
pub(crate) struct RuntimeIdentity {
    pub runtime_id: String,
    pub owner_token: String,
    pub pid: u32,
    pub url: String,
    pub file: PathBuf,
}

impl RuntimeIdentity {
    pub fn new(db_path: &Path, url: String) -> Self {
        let owner_token = std::env::var(OWNER_TOKEN_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));
        Self {
            runtime_id: Uuid::new_v4().to_string(),
            owner_token,
            pid: std::process::id(),
            url,
            file: runtime_file::path_for_database(db_path),
        }
    }

    /// Write `runtime.json`. The server must not serve without it: a server
    /// clients cannot find is a server nobody can drive.
    pub fn publish(&self) -> std::io::Result<()> {
        runtime_file::write(
            &self.file,
            &RuntimeFile {
                runtime_id: self.runtime_id.clone(),
                pid: self.pid,
                url: self.url.clone(),
                owner_token: self.owner_token.clone(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                contract_rev: CONTRACT_REV.to_string(),
                started_at: Utc::now(),
            },
        )
    }

    /// Remove `runtime.json` unless a newer server already replaced it.
    pub fn retire(&self) {
        match runtime_file::remove_if_owned(&self.file, &self.runtime_id) {
            Ok(true) => tracing::info!(path = %self.file.display(), "removed runtime file"),
            Ok(false) => {}
            Err(err) => tracing::warn!(path = %self.file.display(), "failed to remove runtime file: {err}"),
        }
    }
}
