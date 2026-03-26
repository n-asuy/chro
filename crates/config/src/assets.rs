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

pub fn profiles_path() -> PathBuf {
    asset_dir().join("profiles.json")
}
