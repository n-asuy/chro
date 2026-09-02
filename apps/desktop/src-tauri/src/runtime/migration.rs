//! Reconcile the user-data directory used by previous Chro builds.
//!
//! History of the path the desktop app has put its data in:
//!   1. `<appData>/Chro/`                earlier build
//!   2. `<appData>/Chro/chro/db.sqlite`  chro-server runtime nested under userData
//!   3. `<appData>/chro/db.sqlite`       current; matches the Rust server's
//!                                       `DBService::default_path()` so the CLI
//!                                       binary opens the same SQLite file.
//!
//! This runs BEFORE we hand the path to chro-server so subsequent reads see
//! the migrated layout. Ported from `apps/desktop/electron/migration.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use tracing::{info, warn};

const USER_DATA_DIR_ENV: &str = "CHRO_USER_DATA_DIR";

/// Drive every migration step in order. The function is best-effort: if a
/// rename fails, we log and keep going so a single corrupt entry doesn't
/// prevent the app from starting.
pub fn migrate_legacy_user_data(app_data_dir: &Path) {
    // Step 1: `<appData>/Chro/` → `<appData>/chro/`
    migrate_directory(&app_data_dir.join("Chro"), &app_data_dir.join("chro"));

    // Step 2: flatten the nested chro-server runtime dir so `db.sqlite*` sits
    // directly under `<appData>/chro/`.
    let root = app_data_dir.join("chro");
    let nested = root.join("chro");
    if let Err(err) = flatten_nested_runtime_dir(&nested, &root) {
        warn!("failed to flatten {}: {err:#}", nested.display());
    }
}

fn migrate_directory(old_dir: &Path, new_dir: &Path) {
    if !old_dir.exists() {
        return;
    }

    if !new_dir.exists() {
        match fs::rename(old_dir, new_dir) {
            Ok(()) => info!(
                "[migration] Renamed {} -> {}",
                old_dir.display(),
                new_dir.display()
            ),
            Err(err) => warn!("[migration] Failed to rename {}: {err}", old_dir.display()),
        }
        return;
    }

    // Both exist: merge entries from old into new, skipping anything that
    // already exists in new (we never clobber a path the new layout already
    // populated).
    let entries = match fs::read_dir(old_dir) {
        Ok(entries) => entries,
        Err(err) => {
            warn!("[migration] Failed to read {}: {err}", old_dir.display());
            return;
        }
    };

    for entry in entries.flatten() {
        let name = entry.file_name();
        let target = new_dir.join(&name);
        if target.exists() {
            continue;
        }
        let source = old_dir.join(&name);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let result = if file_type.is_file() {
            fs::copy(&source, &target).map(|_| ())
        } else if file_type.is_dir() {
            fs::rename(&source, &target)
        } else {
            continue;
        };
        if let Err(err) = result {
            warn!(
                "[migration] Failed to migrate {} -> {}: {err}",
                source.display(),
                target.display()
            );
        }
    }
    info!("[migration] Merged legacy files from {}", old_dir.display());
}

/// Move every entry from `nested_dir` up into its parent `root`. Used to lift
/// `db.sqlite` (plus the SQLite WAL/SHM files) out of the historical
/// `<appData>/chro/chro/` location.
///
/// On filename conflicts the entry already present in `root` is kept and the
/// conflicting entry from `nested_dir` is renamed alongside with a
/// `.legacy-<timestamp>` suffix so no data is silently dropped.
fn flatten_nested_runtime_dir(nested_dir: &Path, root: &Path) -> Result<()> {
    if !nested_dir.exists() {
        return Ok(());
    }

    let stamp = legacy_stamp();
    for entry in fs::read_dir(nested_dir)?.flatten() {
        let name = entry.file_name();
        let source = nested_dir.join(&name);
        let target = root.join(&name);
        if !target.exists() {
            if let Err(err) = fs::rename(&source, &target) {
                warn!(
                    "[migration] Failed to move {} -> {}: {err}",
                    source.display(),
                    target.display()
                );
            }
            continue;
        }
        let mut backup_name = name.to_os_string();
        backup_name.push(format!(".legacy-{stamp}"));
        let backup = root.join(&backup_name);
        if let Err(err) = fs::rename(&source, &backup) {
            warn!(
                "[migration] Failed to stash {} -> {}: {err}",
                source.display(),
                backup.display()
            );
            continue;
        }
        info!(
            "[migration] Conflict on {}; preserved legacy copy at {}",
            target.display(),
            backup.display()
        );
    }

    // Remove the nested dir if it's empty so the layout fully flattens.
    if fs::read_dir(nested_dir)?.next().is_none() {
        if let Err(err) = fs::remove_dir(nested_dir) {
            warn!(
                "[migration] Failed to remove {}: {err}",
                nested_dir.display()
            );
        } else {
            info!("[migration] Removed empty {}", nested_dir.display());
        }
    }
    Ok(())
}

fn legacy_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    format!("{secs}")
}

/// Resolve the user-data directory used by both the desktop and CLI builds.
///
/// macOS:   `~/Library/Application Support/chro/`
/// Linux:   `$XDG_CONFIG_HOME/chro/` or `~/.config/chro/`
/// Windows: `%APPDATA%\chro\`
///
/// Mirrors `configureSharedUserData` in `apps/desktop/electron/db.ts`.
pub fn user_data_dir_overridden() -> bool {
    std::env::var(USER_DATA_DIR_ENV)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub fn shared_user_data_dir() -> Result<PathBuf> {
    if let Ok(value) = std::env::var(USER_DATA_DIR_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    let base = if cfg!(target_os = "macos") {
        dirs::data_dir()
    } else if cfg!(target_os = "linux") {
        dirs::config_dir()
    } else {
        dirs::data_dir()
    };
    let base = base.ok_or_else(|| anyhow::anyhow!("could not resolve appData directory"))?;
    Ok(base.join("chro"))
}
