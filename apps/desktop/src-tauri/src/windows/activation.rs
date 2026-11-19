//! Bringing a session forward in the app window, shared by every surface that
//! points at a session from outside it: a clicked desktop notification and the
//! edge toolbar's "Open in chro".

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime as TauriRuntime, WebviewWindow};
use tracing::warn;

use super::builder::{create_renderer_window, RendererWindowOptions};
use super::edge::is_edge_window;
use crate::error::DesktopResult;
use crate::runtime::server::primary_runtime;

/// Event emitted to the app window carrying the [`SessionTarget`] to open. The
/// renderer navigates to the session when it receives it.
pub const SESSION_ACTIVATE_EVENT: &str = "session:activate";

/// Route params that identify one session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    pub project_id: String,
    pub task_id: String,
}

impl SessionTarget {
    fn route_path(&self) -> String {
        format!("/projects/{}/session/{}", self.project_id, self.task_id)
    }
}

/// The window that hosts the app proper. The edge toolbar is never it.
pub fn primary_window<R: TauriRuntime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.webview_windows()
        .into_iter()
        .filter(|(label, _)| !is_edge_window(label))
        .min_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, window)| window)
}

/// Show and focus the app window and, when a target is given, open that
/// session in it. With no app window left (the person closed it while the edge
/// toolbar stayed), a new one is opened directly on the session.
pub fn activate_session<R: TauriRuntime>(app: &AppHandle<R>, target: Option<SessionTarget>) {
    let Some(window) = primary_window(app) else {
        if let Some(target) = target {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = open_window_on(&app, &target).await {
                    warn!("[activate] open window failed: {err:#}");
                }
            });
        }
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(target) = target {
        if let Err(err) = app.emit_to(window.label(), SESSION_ACTIVATE_EVENT, target) {
            warn!("[activate] emit failed: {err}");
        }
    }
}

async fn open_window_on<R: TauriRuntime>(
    app: &AppHandle<R>,
    target: &SessionTarget,
) -> anyhow::Result<()> {
    let runtime = primary_runtime(app)
        .await
        .ok_or_else(|| anyhow::anyhow!("no runtime"))?;
    create_renderer_window(
        app,
        &runtime,
        RendererWindowOptions {
            route_path: Some(target.route_path()),
            workspace_path: None,
        },
    )
    .await?;
    crate::tray::refresh_menu(app).await;
    Ok(())
}

/// Event asking the app window to open one of its own views.
pub const APP_VIEW_EVENT: &str = "app:open-view";

/// A view of the app window the edge toolbar's "…" menu opens.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppView {
    Settings,
    Feedback,
}

/// "…" → Settings or Feedback from the edge toolbar: show and focus the app
/// window and open that view in it.
#[tauri::command]
pub fn open_app_view<R: TauriRuntime>(app: AppHandle<R>, view: AppView) -> DesktopResult<()> {
    activate_session(&app, None);
    if let Some(window) = primary_window(&app) {
        if let Err(err) = app.emit_to(window.label(), APP_VIEW_EVENT, view) {
            warn!("[activate] emit {view:?} failed: {err}");
        }
    }
    Ok(())
}

/// "Open in chro" from the edge toolbar.
#[tauri::command]
pub fn open_session_in_app<R: TauriRuntime>(
    app: AppHandle<R>,
    target: SessionTarget,
) -> DesktopResult<()> {
    activate_session(&app, Some(target));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_round_trips_in_camel_case() {
        let target: SessionTarget =
            serde_json::from_str(r#"{"projectId":"p","taskId":"t"}"#).unwrap();
        assert_eq!(target.project_id, "p");
        assert_eq!(target.task_id, "t");
        assert_eq!(
            serde_json::to_string(&target).unwrap(),
            r#"{"projectId":"p","taskId":"t"}"#
        );
    }

    #[test]
    fn app_views_travel_as_camel_case_names() {
        assert_eq!(serde_json::to_string(&AppView::Settings).unwrap(), r#""settings""#);
        assert_eq!(
            serde_json::from_str::<AppView>(r#""feedback""#).unwrap(),
            AppView::Feedback
        );
    }

    #[test]
    fn route_path_opens_the_session_route() {
        let target = SessionTarget {
            project_id: "p1".into(),
            task_id: "t1".into(),
        };
        assert_eq!(target.route_path(), "/projects/p1/session/t1");
    }
}
