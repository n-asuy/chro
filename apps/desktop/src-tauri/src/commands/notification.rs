use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime as TauriRuntime};

use crate::error::DesktopResult;

/// App icon embedded at compile time and materialized to a temp file on first
/// use. The macOS notification API takes an icon by file path (not by handle),
/// so we stage the PNG on disk once and reuse the path for every notification.
const NOTIFICATION_ICON_PNG: &[u8] = include_bytes!("../../icons/icon.png");

/// Event emitted to the renderer when a notification is clicked. The renderer
/// listens for this and navigates to the session, mirroring how `deep-link:url`
/// is consumed.
pub const NOTIFICATION_ACTIVATE_EVENT: &str = "notification:activate";

/// Routing context carried by a notification so a click can reopen the exact
/// session that produced it. Echoed back to the renderer verbatim on click.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTarget {
    pub project_id: String,
    pub task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    pub title: String,
    pub body: Option<String>,
    /// When present, clicking the notification focuses the window and navigates
    /// to this session. Absent for purely informational notifications.
    pub target: Option<NotificationTarget>,
}

#[tauri::command]
pub fn show_notification<R: TauriRuntime>(
    app: AppHandle<R>,
    payload: NotificationPayload,
) -> DesktopResult<()> {
    platform::show(&app, payload);
    Ok(())
}

/// Materialize the embedded icon to a stable temp path, writing it once.
/// Returns `None` if staging fails; callers then fall back to the default icon.
fn icon_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join("chro");
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join("notification-icon.png");
        if !path.exists() {
            std::fs::write(&path, NOTIFICATION_ICON_PNG).ok()?;
        }
        Some(path.to_string_lossy().into_owned())
    })
    .as_deref()
}

/// Focus the primary window and tell the renderer which session to open. Shared
/// across platforms so the navigation contract stays identical.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn activate<R: TauriRuntime>(app: &AppHandle<R>, target: Option<NotificationTarget>) {
    use tauri::Manager;
    if let Some(window) = app.webview_windows().into_values().next() {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(target) = target {
        if let Err(err) = tauri::Emitter::emit(app, NOTIFICATION_ACTIVATE_EVENT, target) {
            tracing::warn!("[notification] activate emit failed: {err}");
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{activate, icon_path, NotificationPayload};
    use objc2::rc::Retained;
    use objc2_foundation::{NSDefaultRunLoopMode, NSPort, NSRunLoop};
    use tauri::{AppHandle, Runtime as TauriRuntime};

    pub fn show<R: TauriRuntime>(app: &AppHandle<R>, payload: NotificationPayload) {
        ensure_application(app);
        let app = app.clone();
        let icon = icon_path();
        let spawned = std::thread::Builder::new()
            .name("chro-notification".into())
            .spawn(move || {
                let NotificationPayload {
                    title,
                    body,
                    target,
                } = payload;

                // `mac_notification_sys::send` parks this thread on a run-loop
                // poll while waiting for a click. A freshly spawned thread's run
                // loop has no input sources, so that poll would return instantly
                // and busy-spin a CPU core. Attaching a port gives the loop
                // something to wait on, so each poll sleeps the interval
                // instead. Kept alive until `send` returns.
                let _wait_port = target.as_ref().map(|_| attach_idle_port());

                let mut notification = mac_notification_sys::Notification::new();
                notification.title(&title);
                if let Some(body) = body.as_deref() {
                    notification.message(body);
                }
                if let Some(icon) = icon {
                    // Overrides the small icon shown at the notification's
                    // top-left, even in dev where delivery borrows Terminal's
                    // bundle identity.
                    notification.app_icon(icon);
                }
                match &target {
                    // Wait for the click so it can be routed back into the app.
                    // The underlying library keeps a single delegate slot on the
                    // shared notification center, so if several notifications
                    // fire in the same instant a click may resolve to the wrong
                    // one — an accepted edge case for simultaneous completions.
                    Some(_) => {
                        notification.wait_for_click(true);
                    }
                    // Nothing to route: fire-and-forget so the thread returns
                    // immediately instead of parking on the notification.
                    None => {
                        notification.asynchronous(true);
                    }
                }

                match notification.send() {
                    Ok(mac_notification_sys::NotificationResponse::Click) => {
                        activate(&app, target);
                    }
                    Ok(_) => {}
                    Err(err) => tracing::warn!("[notification] send failed: {err}"),
                }
            });
        if let Err(err) = spawned {
            tracing::warn!("[notification] thread spawn failed: {err}");
        }
    }

    /// Attach a bare port to the current thread's run loop and hand it back so
    /// the caller can keep it alive. See the call site for why this matters.
    fn attach_idle_port() -> Retained<NSPort> {
        let run_loop = NSRunLoop::currentRunLoop();
        let port = NSPort::port();
        // SAFETY: standard run-loop wiring. The run loop retains the port for
        // its own bookkeeping and we hold a strong reference alongside it.
        unsafe {
            run_loop.addPort_forMode(&port, NSDefaultRunLoopMode);
        }
        port
    }

    /// Bind notifications to a registered bundle. In dev the app bundle is not
    /// registered with LaunchServices, so we borrow Terminal's identity for
    /// delivery (the custom `app_icon` still overrides the visible icon);
    /// production delivers under the real app identifier. Idempotent: the
    /// underlying call only takes effect once per process.
    fn ensure_application<R: TauriRuntime>(app: &AppHandle<R>) {
        let bundle = if tauri::is_dev() {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        };
        let _ = mac_notification_sys::set_application(&bundle);
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::{icon_path, NotificationPayload};
    use tauri::{AppHandle, Runtime as TauriRuntime};
    use tauri_plugin_notification::NotificationExt;

    /// Windows/Linux path: the desktop toast backend cannot report clicks, so
    /// notifications here are display-only (title, body, icon). Click-to-open
    /// the session is a macOS capability today.
    pub fn show<R: TauriRuntime>(app: &AppHandle<R>, payload: NotificationPayload) {
        let mut builder = app.notification().builder().title(&payload.title);
        if let Some(body) = payload.body {
            builder = builder.body(body);
        }
        if let Some(icon) = icon_path() {
            builder = builder.icon(icon);
        }
        // Drop the error: the OS may have denied permission, matching the
        // Electron-era silent behavior.
        let _ = builder.show();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_payload_with_target() {
        let json = r#"{"title":"Done","body":"My task","target":{"projectId":"p1","taskId":"t1"}}"#;
        let payload: NotificationPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.title, "Done");
        assert_eq!(payload.body.as_deref(), Some("My task"));
        let target = payload.target.expect("target present");
        assert_eq!(target.project_id, "p1");
        assert_eq!(target.task_id, "t1");
    }

    #[test]
    fn deserializes_payload_without_target() {
        let payload: NotificationPayload = serde_json::from_str(r#"{"title":"Hi"}"#).unwrap();
        assert_eq!(payload.title, "Hi");
        assert!(payload.body.is_none());
        assert!(payload.target.is_none());
    }

    #[test]
    fn target_serializes_to_camel_case() {
        let target = NotificationTarget {
            project_id: "p".into(),
            task_id: "t".into(),
        };
        let json = serde_json::to_string(&target).unwrap();
        assert_eq!(json, r#"{"projectId":"p","taskId":"t"}"#);
    }

    #[test]
    fn stages_a_valid_png_icon_on_disk() {
        let path = icon_path().expect("icon staged");
        let bytes = std::fs::read(path).expect("icon readable");
        // PNG magic number — confirms the embedded asset round-tripped to disk.
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    }
}
