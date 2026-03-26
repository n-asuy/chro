use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tracing::{info, warn};

struct DirMigration {
    old: PathBuf,
    new: PathBuf,
    label: &'static str,
}

/// Migrate legacy "chronist" data directories to "chro".
///
/// Performs atomic renames where possible.
/// Fails soft — logs warnings on errors and continues.
/// Must be called before any directory creation (e.g., `asset_dir()`, `DBService::new()`).
pub fn migrate_legacy_dirs() {
    let migrations = collect_migrations();
    for m in &migrations {
        match migrate_directory(&m.old, &m.new) {
            Ok(true) => info!(
                old = %m.old.display(),
                new = %m.new.display(),
                "migrated {} directory", m.label
            ),
            Ok(false) => {}
            Err(e) => warn!(
                error = %e,
                old = %m.old.display(),
                new = %m.new.display(),
                "failed to migrate {}, continuing with new path", m.label
            ),
        }
    }
}

fn migrate_directory(old: &Path, new: &Path) -> Result<bool, std::io::Error> {
    if !old.exists() {
        return Ok(false);
    }
    if new.exists() {
        merge_legacy_files(old, new)?;
        return Ok(true);
    }
    if let Some(parent) = new.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(old, new)?;
    Ok(true)
}

fn merge_legacy_files(old: &Path, new: &Path) -> Result<(), std::io::Error> {
    for entry in fs::read_dir(old)? {
        let entry = entry?;
        let target = new.join(entry.file_name());
        if !target.exists() {
            let ft = entry.file_type()?;
            if ft.is_file() {
                fs::copy(entry.path(), &target)?;
            } else if ft.is_dir() {
                fs::rename(entry.path(), &target)?;
            }
        }
    }
    Ok(())
}

fn collect_migrations() -> Vec<DirMigration> {
    let mut migrations = Vec::new();
    let mut seen = HashSet::new();

    let mut push = |old: PathBuf, new: PathBuf, label: &'static str| {
        let key = (old.clone(), new.clone());
        if seen.insert(key) {
            migrations.push(DirMigration { old, new, label });
        }
    };

    // Zone B: config assets via ProjectDirs
    if let (Some(old_proj), Some(new_proj)) = (
        directories::ProjectDirs::from("com", "chronist-ai", "chronist"),
        directories::ProjectDirs::from("com", "chro-ai", "chro"),
    ) {
        push(
            old_proj.data_dir().to_path_buf(),
            new_proj.data_dir().to_path_buf(),
            "config-assets",
        );
    }

    // Zone C: DB default path (standalone server)
    let data_dir = if cfg!(target_os = "macos") {
        dirs::data_local_dir()
    } else {
        dirs::data_dir()
    };
    if let Some(base) = data_dir {
        push(base.join("chronist"), base.join("chro"), "database");
    }

    // Zone E: CLI config
    if let Some(home) = dirs::home_dir() {
        push(home.join(".chronist"), home.join(".chro"), "cli-config");
    }

    migrations
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn rename_when_only_old_exists() {
        let root = tempdir().unwrap();
        let old = root.path().join("old_dir");
        let new = root.path().join("new_dir");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("config.json"), r#"{"version":1}"#).unwrap();
        fs::write(old.join("db.sqlite"), b"SQLite data").unwrap();

        let result = migrate_directory(&old, &new).unwrap();

        assert!(result);
        assert!(!old.exists());
        assert!(new.join("config.json").exists());
        assert!(new.join("db.sqlite").exists());
    }

    #[test]
    fn skip_when_neither_exists() {
        let root = tempdir().unwrap();
        let old = root.path().join("old_dir");
        let new = root.path().join("new_dir");

        let result = migrate_directory(&old, &new).unwrap();

        assert!(!result);
        assert!(!new.exists());
    }

    #[test]
    fn skip_when_only_new_exists() {
        let root = tempdir().unwrap();
        let old = root.path().join("old_dir");
        let new = root.path().join("new_dir");
        fs::create_dir(&new).unwrap();
        fs::write(new.join("config.json"), "new").unwrap();

        let result = migrate_directory(&old, &new).unwrap();

        assert!(!result);
        assert_eq!(fs::read_to_string(new.join("config.json")).unwrap(), "new");
    }

    #[test]
    fn merge_when_both_exist() {
        let root = tempdir().unwrap();
        let old = root.path().join("old_dir");
        let new = root.path().join("new_dir");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();

        // old has a unique file and a shared file
        fs::write(old.join("profiles.json"), "old-profiles").unwrap();
        fs::write(old.join("config.json"), "old-config").unwrap();

        // new already has config.json
        fs::write(new.join("config.json"), "new-config").unwrap();

        let result = migrate_directory(&old, &new).unwrap();

        assert!(result);
        // shared file: new version preserved
        assert_eq!(
            fs::read_to_string(new.join("config.json")).unwrap(),
            "new-config"
        );
        // unique file: copied from old
        assert_eq!(
            fs::read_to_string(new.join("profiles.json")).unwrap(),
            "old-profiles"
        );
    }

    #[test]
    fn merge_moves_subdirectory() {
        let root = tempdir().unwrap();
        let old = root.path().join("old_dir");
        let new = root.path().join("new_dir");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&new).unwrap();

        let sub = old.join("subdir");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("data.txt"), "sub-data").unwrap();

        let result = migrate_directory(&old, &new).unwrap();

        assert!(result);
        assert!(new.join("subdir").join("data.txt").exists());
        assert_eq!(
            fs::read_to_string(new.join("subdir").join("data.txt")).unwrap(),
            "sub-data"
        );
    }

    #[test]
    fn creates_parent_of_new_path() {
        let root = tempdir().unwrap();
        let old = root.path().join("old_dir");
        let new = root.path().join("deeply").join("nested").join("new_dir");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("data.txt"), "hello").unwrap();

        let result = migrate_directory(&old, &new).unwrap();

        assert!(result);
        assert!(new.join("data.txt").exists());
    }
}
