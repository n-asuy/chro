//! `runtime.json`: how a running server tells clients where it is and which
//! key opens its operator API.
//!
//! The file lives in the directory of the server's database. A server holds
//! an exclusive lock on its database, so at most one live server owns a given
//! runtime file; isolated servers started with their own `--db-path` never
//! touch the desktop app's file.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const RUNTIME_FILE_NAME: &str = "runtime.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeFile {
    /// Fresh per server process; lets a client notice the server it talked to
    /// was replaced, and guards removal (see [`remove_if_owned`]).
    pub runtime_id: String,
    pub pid: u32,
    /// Base URL of the HTTP server, without a trailing slash.
    pub url: String,
    /// Bearer token that acts as the machine's user on the operator API.
    pub owner_token: String,
    pub version: String,
    pub contract_rev: String,
    pub started_at: DateTime<Utc>,
}

/// Runtime file of the server that uses the database at `db_path`.
pub fn path_for_database(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(RUNTIME_FILE_NAME)
}

pub fn read(path: &Path) -> io::Result<RuntimeFile> {
    let text = fs::read_to_string(path)?;
    serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// Write `file` to `path`, readable by the current user only.
///
/// The bytes go to a sibling temp file first and are renamed into place, so a
/// client never reads a half-written token.
pub fn write(path: &Path, file: &RuntimeFile) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("json.{}.tmp", file.pid));
    let body = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    write_private(&tmp, &body)?;
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

/// Remove the runtime file only if it still describes `runtime_id`.
///
/// Returns whether a file was removed. A server shutting down must not delete
/// the record of a newer server that already took over the same database.
pub fn remove_if_owned(path: &Path, runtime_id: &str) -> io::Result<bool> {
    match read(path) {
        Ok(current) if current.runtime_id == runtime_id => {
            fs::remove_file(path)?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

#[cfg(unix)]
fn write_private(path: &Path, body: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(body)?;
    file.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, body: &[u8]) -> io::Result<()> {
    // The per-user profile directory the file lives in is already private to
    // its owner on Windows.
    fs::write(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(runtime_id: &str) -> RuntimeFile {
        RuntimeFile {
            runtime_id: runtime_id.into(),
            pid: 4242,
            url: "http://127.0.0.1:4310".into(),
            owner_token: "secret".into(),
            version: "0.1.53".into(),
            contract_rev: crate::CONTRACT_REV.into(),
            started_at: Utc::now(),
        }
    }

    #[test]
    fn lives_beside_the_database() {
        assert_eq!(
            path_for_database(Path::new("/data/chro/db.sqlite")),
            PathBuf::from("/data/chro/runtime.json")
        );
    }

    #[test]
    fn write_then_read_round_trips_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RUNTIME_FILE_NAME);
        let file = sample("rt-a");
        write(&path, &file).unwrap();

        assert_eq!(read(&path).unwrap(), file);
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(names.len(), 1, "temp file must be renamed away");
    }

    #[cfg(unix)]
    #[test]
    fn file_is_private_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RUNTIME_FILE_NAME);
        write(&path, &sample("rt-a")).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn removal_spares_a_newer_server_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RUNTIME_FILE_NAME);
        write(&path, &sample("rt-new")).unwrap();

        assert!(!remove_if_owned(&path, "rt-old").unwrap());
        assert!(path.exists());

        assert!(remove_if_owned(&path, "rt-new").unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn removing_a_missing_file_is_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!remove_if_owned(&dir.path().join(RUNTIME_FILE_NAME), "rt").unwrap());
    }
}
