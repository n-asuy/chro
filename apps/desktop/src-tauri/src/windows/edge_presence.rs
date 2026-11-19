//! The edge toolbar steps aside while chro itself is in front: the full app
//! window and the minimal edge display are never shown together.
//!
//! "chro is in front" means one of its main (session) windows holds the
//! keyboard. That is what the window focus events say: a main window gets
//! focus when chro becomes the active app with it, and loses it when another
//! app becomes active or the window is minimized, hidden or closed. The edge
//! toolbar and the capture window are part of the same app but do not count,
//! so using the toolbar never hides it.
//!
//! The state settles for [`SETTLE`] before it changes (moving between two of
//! chro's windows does not flash the toolbar) and reaches the edge window as
//! `edge-presence`. While hidden, the edge window takes no pointer and the
//! Option gestures do nothing there.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, Runtime as TauriRuntime, Window, WindowEvent};
use tracing::debug;

use super::edge::{is_edge_window, EDGE_WINDOW_LABEL};

/// Event telling the edge window whether to step aside.
pub const PRESENCE_EVENT: &str = "edge-presence";

/// How long the state must hold before the toolbar follows it.
const SETTLE: Duration = Duration::from_millis(150);

/// Which of chro's main windows hold the keyboard.
#[derive(Debug, Default)]
pub struct MainFocus {
    key: BTreeSet<String>,
}

impl MainFocus {
    /// A window gained or lost the keyboard. The edge toolbar's own windows
    /// do not count.
    pub fn focus(&mut self, label: &str, focused: bool) {
        if is_edge_window(label) {
            return;
        }
        if focused {
            self.key.insert(label.to_string());
        } else {
            self.key.remove(label);
        }
    }

    /// A window closed.
    pub fn closed(&mut self, label: &str) {
        self.key.remove(label);
    }

    /// chro's full window is in front: the edge toolbar steps aside.
    pub fn main_in_front(&self) -> bool {
        !self.key.is_empty()
    }
}

static FOCUS: Mutex<MainFocus> = Mutex::new(MainFocus { key: BTreeSet::new() });

/// What the edge window was last told.
static HIDDEN: AtomicBool = AtomicBool::new(false);

/// Bumped by every change, so only the last one within [`SETTLE`] applies.
static PENDING: AtomicU64 = AtomicU64::new(0);

/// Whether the edge toolbar is stepped aside.
pub fn edge_hidden() -> bool {
    HIDDEN.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Copy, Serialize)]
struct Presence {
    hidden: bool,
}

/// Follow the app's window focus events (called for every window event).
pub fn on_window_event<R: TauriRuntime>(window: &Window<R>, event: &WindowEvent) {
    let label = window.label();
    {
        let Ok(mut focus) = FOCUS.lock() else {
            return;
        };
        match event {
            WindowEvent::Focused(focused) => focus.focus(label, *focused),
            WindowEvent::Destroyed => focus.closed(label),
            _ => return,
        }
    }
    let app = window.app_handle().clone();
    let ticket = PENDING.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE).await;
        if PENDING.load(Ordering::SeqCst) != ticket {
            return;
        }
        let hidden = FOCUS.lock().map(|focus| focus.main_in_front()).unwrap_or(false);
        if HIDDEN.swap(hidden, Ordering::SeqCst) != hidden {
            debug!("[edge] presence hidden={hidden}");
            let _ = app.emit_to(EDGE_WINDOW_LABEL, PRESENCE_EVENT, Presence { hidden });
        }
    });
}

/// The current state, for an edge window that just loaded.
#[tauri::command]
pub fn edge_presence() -> bool {
    edge_hidden()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::edge_capture::CAPTURE_WINDOW_LABEL;

    const MAIN: &str = "window-main";

    #[test]
    fn chro_in_front_with_its_main_window_hides_the_toolbar() {
        let mut focus = MainFocus::default();
        focus.focus(MAIN, true);
        assert!(focus.main_in_front());
    }

    #[test]
    fn another_app_in_front_brings_it_back() {
        let mut focus = MainFocus::default();
        focus.focus(MAIN, true);
        // Another app activated: chro's key window resigns.
        focus.focus(MAIN, false);
        assert!(!focus.main_in_front());
    }

    #[test]
    fn a_minimized_hidden_or_closed_main_window_brings_it_back() {
        let mut minimized = MainFocus::default();
        minimized.focus(MAIN, true);
        minimized.focus(MAIN, false); // minimizing or hiding resigns the key window
        assert!(!minimized.main_in_front());

        let mut closed = MainFocus::default();
        closed.focus(MAIN, true);
        closed.closed(MAIN);
        assert!(!closed.main_in_front());
    }

    #[test]
    fn using_the_toolbar_does_not_count_as_chro_in_front() {
        let mut focus = MainFocus::default();
        // The edge window or the capture window takes the keyboard while the
        // main window is in the background.
        focus.focus(EDGE_WINDOW_LABEL, true);
        focus.focus(CAPTURE_WINDOW_LABEL, true);
        assert!(!focus.main_in_front());
        // Clicking from the main window into the toolbar: the main window
        // resigns, the toolbar's focus is ignored.
        focus.focus(MAIN, true);
        focus.focus(MAIN, false);
        focus.focus(EDGE_WINDOW_LABEL, true);
        assert!(!focus.main_in_front());
    }

    #[test]
    fn opening_a_session_from_the_toolbar_hides_it() {
        let mut focus = MainFocus::default();
        focus.focus(EDGE_WINDOW_LABEL, true);
        // "Open in chro": the main window comes forward with the keyboard.
        focus.focus(EDGE_WINDOW_LABEL, false);
        focus.focus(MAIN, true);
        assert!(focus.main_in_front());
    }

    #[test]
    fn moving_between_two_main_windows_keeps_it_hidden() {
        let mut focus = MainFocus::default();
        focus.focus(MAIN, true);
        focus.focus("window-second", true);
        focus.focus(MAIN, false);
        assert!(focus.main_in_front());
    }
}
