use tauri::{AppHandle, Manager, Runtime as TauriRuntime, Webview};

use crate::error::{DesktopError, DesktopResult};
use crate::runtime::pool::WindowPool;
use crate::windows::{set_window_mode as apply_window_mode, WindowMode};

#[tauri::command]
pub async fn set_window_mode<R: TauriRuntime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    mode: WindowMode,
) -> DesktopResult<()> {
    let label = webview.label().to_string();
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| DesktopError::InvalidRequest(format!("unknown window: {label}")))?;
    let pool = app.state::<WindowPool>();
    if !pool.set_mode(&label, mode).await {
        // The window is already in this mode. Re-applying geometry here would
        // re-center the window on every route change and clobber a position the
        // user set by hand, so we only touch geometry on a genuine transition.
        return Ok(());
    }
    apply_window_mode(&app, &window, mode);
    crate::tray::refresh_menu(&app).await;
    Ok(())
}
