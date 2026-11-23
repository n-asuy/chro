//! The main window's life while the edge toolbar beta is on: the window and
//! the edge take turns.
//!
//! - Closing the last main window (×, ⌘⇧W) hides it instead: the app keeps
//!   running, the edge comes back (it is shown whenever no main window is in
//!   front, see `edge_presence`), and reopening is instant with the window's
//!   state (tabs, drafts) kept. With the beta off there is no edge, and
//!   closing works as it always has (the last window quits the app).
//! - Clicking the Dock icon (macOS reopen) shows the main window again, or
//!   opens a new one if none exists.
//! - Turning the beta off while the main window is hidden shows it again, so
//!   the app is never left running with nothing on screen.
//! - ⌘Q quits everything: the system quit does not go through a window's
//!   close request, so nothing here holds it up.

use tauri::{AppHandle, CloseRequestApi, Manager, Runtime as TauriRuntime, Window};
use tracing::{debug, warn};

use super::activation::primary_window;
use super::edge::{is_edge_window, EDGE_WINDOW_LABEL};

/// What a close request on a main window does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide it: the edge toolbar takes over until it is reopened.
    Hide,
    /// Close it as usual.
    Close,
}

/// A main window asked to close. It is hidden only when the edge toolbar is
/// on and no other main window is still showing; otherwise it closes.
pub fn close_action(edge_open: bool, other_visible_main_windows: usize) -> CloseAction {
    if edge_open && other_visible_main_windows == 0 {
        CloseAction::Hide
    } else {
        CloseAction::Close
    }
}

/// What bringing the app back (Dock icon, a request from the edge) does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reopen {
    /// Show and focus this (possibly hidden or minimized) window.
    Show(String),
    /// There is no main window left: open one.
    Create,
}

/// The main window to bring back: the first by label, as `primary_window`.
pub fn reopen_action(main_windows: &[String]) -> Reopen {
    main_windows
        .iter()
        .min()
        .map_or(Reopen::Create, |label| Reopen::Show(label.clone()))
}

/// The edge toolbar was turned off: a hidden main window must come back, or
/// the app would run with nothing on screen.
pub fn show_main_after_edge_closed(main_window_visible: bool) -> bool {
    !main_window_visible
}

/// Handle a close request (called from the app's window events).
pub fn on_close_requested<R: TauriRuntime>(window: &Window<R>, api: &CloseRequestApi) {
    let label = window.label();
    if is_edge_window(label) {
        return;
    }
    let app = window.app_handle();
    let edge_open = app.get_webview_window(EDGE_WINDOW_LABEL).is_some();
    let others = app
        .webview_windows()
        .into_iter()
        .filter(|(other, w)| {
            other != label && !is_edge_window(other) && w.is_visible().unwrap_or(false)
        })
        .count();
    if close_action(edge_open, others) == CloseAction::Hide {
        api.prevent_close();
        debug!("[main] close of {label} hides it: the edge toolbar takes over");
        if let Err(err) = window.hide() {
            warn!("[main] hide failed: {err}");
        }
    }
}

/// Bring the main window back and focus it (Dock icon, the edge's requests).
pub fn reopen<R: TauriRuntime>(app: &AppHandle<R>) {
    let labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| !is_edge_window(label))
        .collect();
    match reopen_action(&labels) {
        Reopen::Show(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                debug!("[main] reopen shows {label}");
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        Reopen::Create => {
            debug!("[main] reopen opens a new main window");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = super::activation::open_main_window(&app, None).await {
                    warn!("[main] open window failed: {err:#}");
                }
            });
        }
    }
}

/// After the edge window closed (beta switched off or withdrawn).
pub fn after_edge_closed<R: TauriRuntime>(app: &AppHandle<R>) {
    let visible = primary_window(app).is_some_and(|w| w.is_visible().unwrap_or(false));
    if show_main_after_edge_closed(visible) {
        reopen(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_last_main_window_hides_it_while_the_edge_is_on() {
        assert_eq!(close_action(true, 0), CloseAction::Hide);
    }

    #[test]
    fn closing_works_as_before_with_the_beta_off() {
        assert_eq!(close_action(false, 0), CloseAction::Close);
    }

    #[test]
    fn closing_one_of_several_main_windows_closes_it() {
        assert_eq!(close_action(true, 1), CloseAction::Close);
    }

    #[test]
    fn reopening_shows_the_existing_main_window_or_opens_one() {
        assert_eq!(
            reopen_action(&["window-b".into(), "window-a".into()]),
            Reopen::Show("window-a".into())
        );
        assert_eq!(reopen_action(&[]), Reopen::Create);
    }

    #[test]
    fn turning_the_beta_off_brings_a_hidden_main_window_back() {
        assert!(show_main_after_edge_closed(false));
        assert!(!show_main_after_edge_closed(true));
    }
}
