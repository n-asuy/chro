//! Application menu bar (macOS).
//!
//! macOS routes menu key-equivalents through `performKeyEquivalent:` *before*
//! the keystroke reaches WKWebView, so a renderer-side `keydown` handler can
//! never reliably intercept ⌘W — the OS default ("Close Window") fires first.
//! The only robust place to remap ⌘W to "close the active tab" is the native
//! menu itself. We therefore own the whole menu bar on macOS: ⌘W is bound to a
//! custom "Close Tab" item that emits an event to the focused window, and the
//! window-closing shortcut moves to ⇧⌘W. ⌘A is also routed through the
//! renderer so the session screen can select only conversation text. The other
//! entries mirror the macOS default menu so copy/paste/undo and friends keep
//! working.
//!
//! Non-macOS platforms keep Tauri's default (no app menu); WebView2/Linux do
//! not bind Ctrl+W to window close, so there is nothing to remap there.

#[cfg(target_os = "macos")]
use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Emitter, Manager, Runtime as TauriRuntime,
};

/// Menu item id for "Close Tab" (⌘W). Emits [`CLOSE_ACTIVE_TAB_EVENT`].
pub const CLOSE_TAB_ID: &str = "chro-close-tab";
/// Menu item id for "Close Window" (⇧⌘W).
pub const CLOSE_WINDOW_ID: &str = "chro-close-window";
/// Menu item id for "Select All" (⌘A). Emits [`SELECT_ALL_EVENT`].
pub const SELECT_ALL_ID: &str = "chro-select-all";
/// Event emitted to the focused window when ⌘W is pressed. The renderer
/// closes the active tab of the focused pane in response.
pub const CLOSE_ACTIVE_TAB_EVENT: &str = "chro://close-active-tab";
/// Event emitted to the focused window when ⌘A is pressed. The renderer
/// decides whether to select editable text or session conversation text.
pub const SELECT_ALL_EVENT: &str = "chro://select-all";

const APP_NAME: &str = "Chro";

/// Build the macOS application menu bar. Mirrors the system default menu but
/// rebinds ⌘W to "Close Tab" and ⇧⌘W to "Close Window".
#[cfg(target_os = "macos")]
pub fn build_app_menu<R: TauriRuntime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        handle,
        APP_NAME,
        true,
        &[
            &PredefinedMenuItem::about(handle, Some(APP_NAME), Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let select_all = MenuItem::with_id(
        handle,
        SELECT_ALL_ID,
        "Select All",
        true,
        Some("CmdOrCtrl+A"),
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &select_all,
        ],
    )?;

    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;

    let close_tab =
        MenuItem::with_id(handle, CLOSE_TAB_ID, "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let close_window = MenuItem::with_id(
        handle,
        CLOSE_WINDOW_ID,
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &close_tab,
            &close_window,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::bring_all_to_front(handle, None)?,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

/// Dispatch an application-menu event. Returns `true` when the event belonged
/// to this module (so the caller can stop further handling).
#[cfg(target_os = "macos")]
pub fn handle_menu_event<R: TauriRuntime>(app: &AppHandle<R>, id: &str) -> bool {
    match id {
        CLOSE_TAB_ID => {
            if let Some(window) = focused_window(app) {
                let _ = window.emit(CLOSE_ACTIVE_TAB_EVENT, ());
            }
            true
        }
        CLOSE_WINDOW_ID => {
            if let Some(window) = focused_window(app) {
                let _ = window.close();
            }
            true
        }
        SELECT_ALL_ID => {
            if let Some(window) = focused_window(app) {
                let _ = window.emit(SELECT_ALL_EVENT, ());
            }
            true
        }
        _ => false,
    }
}

/// The currently key/focused webview window, if any. The native menu always
/// targets the key window, so we route the event there rather than guessing.
#[cfg(target_os = "macos")]
fn focused_window<R: TauriRuntime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}
