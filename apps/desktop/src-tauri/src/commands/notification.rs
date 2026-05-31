use serde::Deserialize;
use tauri::{AppHandle, Runtime as TauriRuntime};
use tauri_plugin_notification::NotificationExt;

use crate::error::DesktopResult;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub title: String,
    pub body: Option<String>,
}

#[tauri::command]
pub fn show_notification<R: TauriRuntime>(
    app: AppHandle<R>,
    payload: NotificationPayload,
) -> DesktopResult<()> {
    let mut builder = app.notification().builder().title(&payload.title);
    if let Some(body) = payload.body {
        builder = builder.body(body);
    }
    // Drop the error: notification can't be shown if the OS denied us
    // permission, and the Electron build also silently ignored that case.
    let _ = builder.show();
    Ok(())
}
