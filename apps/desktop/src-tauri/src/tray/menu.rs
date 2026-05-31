use anyhow::Result;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuId, MenuItem, PredefinedMenuItem},
    AppHandle, Manager, Runtime as TauriRuntime,
};

use crate::runtime::pool::WindowPool;

const EXIT_ID: &str = "chro-tray-exit";
const NO_WINDOWS_ID: &str = "chro-tray-empty";
const WINDOW_PREFIX: &str = "chro-tray-window:";

/// Build the tray context menu reflecting the currently-open workspace
/// windows. Each workspace window shows up as a check item that focuses the
/// corresponding window when clicked.
pub async fn build_tray_menu<R: TauriRuntime>(app: &AppHandle<R>) -> Result<Menu<R>> {
    let pool = app.state::<WindowPool>();
    let windows = pool.workspace_windows_for_tray().await;

    let menu = Menu::new(app)?;

    if windows.is_empty() {
        let empty = MenuItem::with_id(
            app,
            NO_WINDOWS_ID,
            "No workspace windows",
            false,
            None::<&str>,
        )?;
        menu.append(&empty)?;
    } else {
        for entry in windows {
            let id = format!("{WINDOW_PREFIX}{}", entry.label);
            let label = entry.display_label.clone();
            let item =
                CheckMenuItem::with_id(app, &id, &label, true, entry.is_focused, None::<&str>)?;
            menu.append(&item)?;
        }
    }

    let separator = PredefinedMenuItem::separator(app)?;
    let exit = MenuItem::with_id(app, EXIT_ID, "Exit Chro", true, None::<&str>)?;
    menu.append(&separator)?;
    menu.append(&exit)?;
    Ok(menu)
}

pub fn is_window_focus_id(id: &MenuId) -> Option<String> {
    let raw = id.0.as_str();
    raw.strip_prefix(WINDOW_PREFIX).map(|s| s.to_string())
}

pub fn is_exit_id(id: &MenuId) -> bool {
    id.0.as_str() == EXIT_ID
}
