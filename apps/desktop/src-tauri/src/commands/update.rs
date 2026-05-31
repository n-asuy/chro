use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Runtime as TauriRuntime};
use tauri_plugin_updater::UpdaterExt;
use tracing::warn;

use crate::error::DesktopResult;

pub const UPDATE_STATUS_EVENT: &str = "update:status";

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum UpdateStatus {
    Checking,
    Available {
        version: String,
        #[serde(rename = "releaseNotes", skip_serializing_if = "Option::is_none")]
        release_notes: Option<String>,
    },
    #[serde(rename = "not-available")]
    NotAvailable { version: String },
    Downloading {
        percent: f64,
    },
    Downloaded {
        version: String,
    },
    Error {
        message: String,
    },
}

fn broadcast_status<R: TauriRuntime>(app: &AppHandle<R>, status: &UpdateStatus) {
    if let Err(err) = app.emit(UPDATE_STATUS_EVENT, status) {
        warn!("[update] failed to emit status: {err}");
    }
}

fn auto_updater_enabled() -> bool {
    let Ok(value) = std::env::var("CHRO_ENABLE_AUTO_UPDATER") else {
        return false;
    };
    let normalized = value.trim().to_ascii_lowercase();
    matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
}

fn is_dev() -> bool {
    // In dev (`tauri dev`) the renderer points at the Vite server. We use this
    // signal to skip the updater entirely so a developer never sees a
    // "checking for updates" toast while iterating.
    cfg!(debug_assertions)
}

#[tauri::command]
pub async fn update_check<R: TauriRuntime>(app: AppHandle<R>) -> DesktopResult<Value> {
    if is_dev() {
        return Ok(json!({"status": "dev-mode"}));
    }
    if !auto_updater_enabled() {
        return Ok(json!({"status": "error", "error": "Auto-updater is disabled."}));
    }

    broadcast_status(&app, &UpdateStatus::Checking);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => {
            return Ok(json!({"status": "error", "error": err.to_string()}));
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let release_notes = update.body.clone();
            broadcast_status(
                &app,
                &UpdateStatus::Available {
                    version: version.clone(),
                    release_notes: release_notes.clone(),
                },
            );
            Ok(json!({
                "status": "checked",
                "updateInfo": {
                    "version": version,
                    "releaseNotes": release_notes,
                }
            }))
        }
        Ok(None) => {
            let current = app.package_info().version.to_string();
            broadcast_status(
                &app,
                &UpdateStatus::NotAvailable {
                    version: current.clone(),
                },
            );
            Ok(json!({"status": "checked", "updateInfo": null}))
        }
        Err(err) => {
            let message = format_update_error(&err);
            broadcast_status(
                &app,
                &UpdateStatus::Error {
                    message: message.clone(),
                },
            );
            Ok(json!({"status": "error", "error": message}))
        }
    }
}

#[tauri::command]
pub async fn update_download<R: TauriRuntime>(app: AppHandle<R>) -> DesktopResult<Value> {
    if is_dev() {
        return Ok(json!({"status": "dev-mode"}));
    }
    if !auto_updater_enabled() {
        return Ok(json!({"status": "error", "error": "Auto-updater is disabled."}));
    }
    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => {
            return Ok(json!({"status": "error", "error": err.to_string()}));
        }
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Ok(json!({"status": "error", "error": "No update available."})),
        Err(err) => {
            let message = format_update_error(&err);
            return Ok(json!({"status": "error", "error": message}));
        }
    };

    let app_for_progress = app.clone();
    let app_for_done = app.clone();
    let version_for_done = update.version.clone();

    let result = update
        .download_and_install(
            move |chunk, total| {
                let total = total.unwrap_or(0).max(1) as f64;
                let percent = (chunk as f64 / total) * 100.0;
                broadcast_status(&app_for_progress, &UpdateStatus::Downloading { percent });
            },
            move || {
                broadcast_status(
                    &app_for_done,
                    &UpdateStatus::Downloaded {
                        version: version_for_done.clone(),
                    },
                );
            },
        )
        .await;

    match result {
        Ok(()) => Ok(json!({"status": "downloading"})),
        Err(err) => {
            let message = format_update_error(&err);
            broadcast_status(
                &app,
                &UpdateStatus::Error {
                    message: message.clone(),
                },
            );
            Ok(json!({"status": "error", "error": message}))
        }
    }
}

#[tauri::command]
pub async fn update_install<R: TauriRuntime>(app: AppHandle<R>) -> DesktopResult<()> {
    if is_dev() || !auto_updater_enabled() {
        return Ok(());
    }
    app.restart();
}

fn format_update_error(err: &tauri_plugin_updater::Error) -> String {
    let raw = err.to_string();
    if raw.to_lowercase().contains("zip file not provided") {
        return "This release is missing the macOS update package. Install from DMG or wait for the next release.".to_string();
    }
    if raw.to_lowercase().contains("code signature") && raw.to_lowercase().contains("did not pass")
        || raw
            .to_lowercase()
            .contains("code failed to satisfy specified code requirement")
    {
        return "The downloaded update failed signature validation. Reinstall from the latest DMG."
            .to_string();
    }
    "Failed to update. Please try again later.".to_string()
}
