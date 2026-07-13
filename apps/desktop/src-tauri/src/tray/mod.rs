pub mod icon;
pub mod menu;
pub mod state;

use std::sync::Mutex as StdMutex;

use once_cell::sync::Lazy;
use serde::Deserialize;
use tauri::image::Image;
use tauri::tray::{TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime as TauriRuntime};
use tracing::warn;

use crate::error::DesktopResult;

pub use state::{TrayState, TrayStatus};

/// Holding the current tray state behind a single global mutex matches the
/// Electron implementation closely — that was one `let lastState` shared by
/// every render call.
pub static TRAY_STATE: Lazy<StdMutex<TrayState>> = Lazy::new(|| StdMutex::new(TrayState::default()));

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrayUpdatePayload {
    pub task_count: Option<u32>,
    pub status: Option<TrayStatus>,
}

const TRAY_ID: &str = "chro-tray";

pub fn install_tray<R: TauriRuntime>(app: &AppHandle<R>) -> anyhow::Result<TrayIcon<R>> {
    let state = TRAY_STATE
        .lock()
        .expect("tray state mutex poisoned")
        .clone();
    let (bytes, width, height) = icon::render_tray_image(&state)?;
    let image = Image::new_owned(bytes, width, height);

    let app_for_click = app.clone();
    let app_for_menu = app.clone();

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(image)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(tooltip_for(&state))
        .on_tray_icon_event(move |_tray, event| match event {
            TrayIconEvent::Click { .. } => {
                let app = app_for_click.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = focus_primary_window(&app).await {
                        warn!("[tray] failed to focus primary window: {err}");
                    }
                });
            }
            _ => {}
        })
        .on_menu_event(move |app, event| {
            handle_menu_event(app_for_menu.clone(), app, event);
        })
        .build(app)?;

    let app_for_initial_menu = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh_menu(&app_for_initial_menu).await;
    });

    Ok(tray)
}

fn tooltip_for(state: &TrayState) -> String {
    if state.task_count > 0 {
        format!("Agent タスク実行中: {} 件", state.task_count)
    } else {
        "Agent タスクは実行中なし".to_string()
    }
}

pub async fn refresh_menu<R: TauriRuntime>(app: &AppHandle<R>) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let menu = match menu::build_tray_menu(app).await {
        Ok(m) => m,
        Err(err) => {
            warn!("[tray] failed to build menu: {err}");
            return;
        }
    };
    if let Err(err) = tray.set_menu(Some(menu)) {
        warn!("[tray] failed to set menu: {err}");
    }
}

pub async fn apply_state<R: TauriRuntime>(
    app: &AppHandle<R>,
    payload: TrayUpdatePayload,
) -> anyhow::Result<()> {
    {
        let mut state = TRAY_STATE.lock().expect("tray state mutex poisoned");
        if let Some(count) = payload.task_count {
            state.task_count = count;
        }
        if let Some(status) = payload.status {
            state.status = status;
        }
    }
    let snapshot = TRAY_STATE
        .lock()
        .expect("tray state mutex poisoned")
        .clone();
    let (bytes, width, height) = icon::render_tray_image(&snapshot)?;
    let image = Image::new_owned(bytes, width, height);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_icon(Some(image))?;
        tray.set_tooltip(Some(tooltip_for(&snapshot)))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn tray_update<R: TauriRuntime>(
    app: AppHandle<R>,
    payload: TrayUpdatePayload,
) -> DesktopResult<()> {
    apply_state(&app, payload)
        .await
        .map_err(|err| crate::error::DesktopError::Other(err.to_string()))
}

fn handle_menu_event<R: TauriRuntime>(
    app_handle: AppHandle<R>,
    _passthrough: &AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    if let Some(label) = menu::is_window_focus_id(event.id()) {
        tauri::async_runtime::spawn(async move {
            focus_window_by_label(&app_handle, &label).await;
        });
        return;
    }

    if menu::is_exit_id(event.id()) {
        app_handle.exit(0);
        return;
    }

    // File context menu uses the same menu event surface; dispatch to its
    // pending oneshot if the id matches.
    let id = event.id().0.as_str();
    if id == crate::commands::file_menu::CTX_RENAME_ID
        || id == crate::commands::file_menu::CTX_DELETE_ID
    {
        let mut pending = crate::commands::file_menu::PENDING_CONTEXT_MENU
            .lock()
            .expect("context menu mutex poisoned");
        if let Some(sender) = pending.take() {
            let _ = sender.send(id.to_string());
        }
    }
}

async fn focus_primary_window<R: TauriRuntime>(app: &AppHandle<R>) -> anyhow::Result<()> {
    let pool = app.state::<crate::runtime::WindowPool>();
    let entries = pool.workspace_windows_for_tray().await;
    if entries.len() > 1 {
        refresh_menu(app).await;
        return Ok(());
    }
    let label = if let Some(entry) = entries.first() {
        entry.label.clone()
    } else {
        // Fall back to any open window.
        let all = pool.list().await;
        let Some(first) = all.first() else {
            return Ok(());
        };
        first.label.clone()
    };
    focus_window_by_label(app, &label).await;
    Ok(())
}

async fn focus_window_by_label<R: TauriRuntime>(app: &AppHandle<R>, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    refresh_menu(app).await;
}
