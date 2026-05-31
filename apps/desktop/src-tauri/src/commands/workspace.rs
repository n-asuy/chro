use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime as TauriRuntime, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::error::{DesktopError, DesktopResult};
use crate::runtime::pool::WindowPool;
use crate::runtime::server::primary_runtime;
use crate::windows::{
    create_renderer_window, normalize_route_path, RendererWindowOptions, WindowMode,
};

#[tauri::command]
pub async fn select_workspace<R: TauriRuntime>(
    app: AppHandle<R>,
    webview: Webview<R>,
) -> DesktopResult<Option<String>> {
    let parent_label = webview.label().to_string();
    let parent_window = app.get_webview_window(&parent_label);

    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_title("Select workspace folder");
    if let Some(parent) = parent_window.as_ref() {
        builder = builder.set_parent(parent);
    }
    builder.pick_folder(move |path| {
        let _ = tx.send(path);
    });

    let picked = rx.await.ok().flatten();
    let path = match picked {
        Some(p) => p,
        None => return Ok(None),
    };
    let path_buf: PathBuf = match path.into_path() {
        Ok(p) => p,
        Err(err) => {
            return Err(DesktopError::InvalidPath(err.to_string()));
        }
    };

    if !path_buf.is_dir() {
        let mut builder = app
            .dialog()
            .message("The selected path is not a directory. Please choose another folder.")
            .title("Not a directory")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::Ok);
        if let Some(parent) = parent_window.as_ref() {
            builder = builder.parent(parent);
        }
        builder.blocking_show();
        return Ok(None);
    }

    Ok(Some(path_buf.to_string_lossy().into_owned()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectWindowPayload {
    pub workspace_path: Option<String>,
    pub route_path: Option<String>,
    pub reuse_current_window: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectWindowResult {
    pub action: String,
    pub window_label: String,
}

#[tauri::command]
pub async fn open_project_window<R: TauriRuntime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    payload: OpenProjectWindowPayload,
) -> DesktopResult<OpenProjectWindowResult> {
    let workspace_path = payload
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or(DesktopError::WorkspaceNotSet)?;

    let route_path = normalize_route_path(payload.route_path.as_deref());
    let source_label = webview.label().to_string();
    let pool = app.state::<WindowPool>();

    if let Some(existing) = pool.find_window_for_workspace(&workspace_path).await {
        if let Some(window) = app.get_webview_window(&existing.label) {
            window.show().ok();
            window.unminimize().ok();
            window.set_focus().ok();
            if source_label != existing.label {
                if let Some(source_meta) = pool.get(&source_label).await {
                    if source_meta.workspace_path.is_none() {
                        if let Some(source) = app.get_webview_window(&source_label) {
                            let _ = source.close();
                            pool.remove(&source_label).await;
                        }
                    }
                }
            }
            return Ok(OpenProjectWindowResult {
                action: "focused".to_string(),
                window_label: existing.label,
            });
        }
    }

    let reuse_current = payload.reuse_current_window.unwrap_or(true);
    if reuse_current {
        if let Some(source_meta) = pool.get(&source_label).await {
            if source_meta.workspace_path.is_none() {
                if let Some(window) = app.get_webview_window(&source_label) {
                    pool.set_workspace_path(&source_label, Some(workspace_path.clone()))
                        .await;
                    if pool.set_mode(&source_label, WindowMode::Session).await {
                        crate::windows::set_window_mode(&app, &window, WindowMode::Session);
                    }
                    window.show().ok();
                    window.unminimize().ok();
                    window.set_focus().ok();
                    crate::tray::refresh_menu(&app).await;
                    return Ok(OpenProjectWindowResult {
                        action: "current".to_string(),
                        window_label: source_label,
                    });
                }
            }
        }
    }

    let runtime = primary_runtime(&app)
        .await
        .ok_or(DesktopError::NoRuntimeAvailable)?;
    let window = create_renderer_window(
        &app,
        &runtime,
        RendererWindowOptions {
            initial_mode: WindowMode::Session,
            route_path: Some(route_path),
            workspace_path: Some(workspace_path),
        },
    )
    .await
    .map_err(DesktopError::from)?;

    crate::tray::refresh_menu(&app).await;

    Ok(OpenProjectWindowResult {
        action: "opened".to_string(),
        window_label: window.label().to_string(),
    })
}
