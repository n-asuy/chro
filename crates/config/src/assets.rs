//! Asset directory utilities for profile and config storage.

use std::path::PathBuf;

use directories::ProjectDirs;

const PROJECT_ROOT: &str = env!("CARGO_MANIFEST_DIR");

pub fn asset_dir() -> PathBuf {
    let path = if cfg!(debug_assertions) {
        PathBuf::from(PROJECT_ROOT).join("../../dev_assets")
    } else {
        ProjectDirs::from("com", "chro-ai", "chro")
            .expect("OS didn't give us a home directory")
            .data_dir()
            .to_path_buf()
    };

    if !path.exists() {
        std::fs::create_dir_all(&path).expect("Failed to create asset directory");
    }

    path
}

pub fn config_path() -> PathBuf {
    asset_dir().join("config.json")
}

/// Persistent root for general-purpose ("scratch") chats. Each scratch chat
/// runs in a per-chat subfolder under this directory, and the hidden "General"
/// project is keyed on this path. Created on first use so it can serve as a
/// valid, existing workspace path.
pub fn chats_dir() -> PathBuf {
    let path = asset_dir().join("chats");

    if !path.exists() {
        std::fs::create_dir_all(&path).expect("Failed to create chats directory");
    }

    path
}

pub fn profiles_path() -> PathBuf {
    asset_dir().join("profiles.json")
}
