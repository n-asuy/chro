use std::sync::Mutex as StdMutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Manager, Runtime as TauriRuntime, Webview,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;

use crate::error::{DesktopError, DesktopResult};

pub(crate) static PENDING_CONTEXT_MENU: Lazy<StdMutex<Option<oneshot::Sender<String>>>> =
    Lazy::new(|| StdMutex::new(None));

pub const CTX_RENAME_ID: &str = "chro-ctx-rename";
pub const CTX_DELETE_ID: &str = "chro-ctx-delete";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMenuPayload {
    pub path: String,
    pub name: String,
}

/// Pop up the file context menu attached to the window that invoked the
/// command and wait for the user's selection. Mirrors the Electron
/// `desktop:show-file-context-menu` handler.
#[tauri::command]
pub async fn show_file_context_menu<R: TauriRuntime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    payload: FileMenuPayload,
) -> DesktopResult<Option<Value>> {
    let label = webview.label().to_string();
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| DesktopError::InvalidRequest(format!("unknown window: {label}")))?;

    let rename =
        MenuItem::with_id(&app, CTX_RENAME_ID, "Rename", true, None::<&str>).map_err(to_err)?;
    let sep = PredefinedMenuItem::separator(&app).map_err(to_err)?;
    let delete =
        MenuItem::with_id(&app, CTX_DELETE_ID, "Delete", true, None::<&str>).map_err(to_err)?;
    let menu = Menu::new(&app).map_err(to_err)?;
    menu.append(&rename).map_err(to_err)?;
    menu.append(&sep).map_err(to_err)?;
    menu.append(&delete).map_err(to_err)?;

    let (tx, rx) = oneshot::channel();
    *PENDING_CONTEXT_MENU.lock().expect("context menu mutex poisoned") = Some(tx);

    window.popup_menu(&menu).map_err(to_err)?;

    // 60s is plenty for a context menu — past that the user clearly walked
    // away. Clearing the slot here means a stale popup_menu doesn't pin a
    // sender that can never resolve.
    let action = match tokio::time::timeout(Duration::from_secs(60), rx).await {
        Ok(Ok(action)) => Some(action),
        _ => {
            *PENDING_CONTEXT_MENU.lock().expect("context menu mutex poisoned") = None;
            None
        }
    };
    *PENDING_CONTEXT_MENU.lock().expect("context menu mutex poisoned") = None;

    let Some(action) = action else { return Ok(None); };

    if action == CTX_RENAME_ID {
        return Ok(Some(json!({"action": "rename"})));
    }
    if action == CTX_DELETE_ID {
        let message = format!("Are you sure you want to delete \"{}\"?", payload.name);
        let confirmed = app
            .dialog()
            .message(message)
            .title("Delete File")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Move to Trash".into(),
                "Cancel".into(),
            ))
            .blocking_show();
        if confirmed {
            return Ok(Some(json!({"action": "delete", "confirmed": true})));
        }
    }
    Ok(None)
}

fn to_err<E: std::fmt::Display>(err: E) -> DesktopError {
    DesktopError::Other(err.to_string())
}
