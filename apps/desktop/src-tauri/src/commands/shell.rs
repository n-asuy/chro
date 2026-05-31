use tauri::{AppHandle, Runtime as TauriRuntime};
use tauri_plugin_opener::OpenerExt;

use crate::error::{DesktopError, DesktopResult};

/// Open `url` in the host operating system's default handler. We delegate to
/// `tauri-plugin-opener` so the URL is validated and the open is scoped via
/// capabilities rather than letting arbitrary processes through.
#[tauri::command]
pub fn open_external_url<R: TauriRuntime>(
    app: AppHandle<R>,
    url: String,
) -> DesktopResult<()> {
    if url.trim().is_empty() {
        return Err(DesktopError::InvalidRequest("url is empty".into()));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| DesktopError::Other(err.to_string()))
}

/// Open a local filesystem path in the host operating system's default handler
/// or in a specific application when `with` is provided.
#[tauri::command]
pub fn open_path<R: TauriRuntime>(
    app: AppHandle<R>,
    path: String,
    with: Option<String>,
) -> DesktopResult<()> {
    let path = path.trim();
    if path.is_empty() {
        return Err(DesktopError::InvalidRequest("path is empty".into()));
    }

    let with = with
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    app.opener()
        .open_path(path.to_string(), with)
        .map_err(|err| DesktopError::Other(err.to_string()))
}
