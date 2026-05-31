use tauri::{AppHandle, Runtime as TauriRuntime, Webview};

use crate::error::DesktopResult;
use crate::runtime::pool::WindowPool;
use crate::runtime::server::{platform_string, primary_runtime, RuntimeInfoPayload};

#[tauri::command]
pub async fn get_runtime_info<R: TauriRuntime>(
    app: AppHandle<R>,
    webview: Webview<R>,
) -> DesktopResult<RuntimeInfoPayload> {
    let label = webview.label().to_string();
    let pool = app.state::<WindowPool>();
    let runtime = primary_runtime(&app).await;
    let window_meta = pool.get(&label).await;

    if let Some(runtime) = runtime {
        let workspace_path = match window_meta {
            Some(meta) => meta.workspace_path.or(runtime.workspace_path().await),
            None => runtime.workspace_path().await,
        };
        Ok(RuntimeInfoPayload {
            runtime_id: Some(runtime.id.clone()),
            backend_url: runtime.base_url.clone(),
            workspace_path,
            platform: platform_string(),
        })
    } else {
        // Tauri's beforeDevCommand wires the renderer at http://localhost:3400
        // in development; we mirror that fallback here so the renderer can
        // still talk to a manually-spawned chro-server during isolated work.
        Ok(RuntimeInfoPayload {
            runtime_id: None,
            backend_url: "http://localhost:3400".to_string(),
            workspace_path: None,
            platform: platform_string(),
        })
    }
}

// Keep the `tauri::Manager` import alive for `app.state::<...>()`.
use tauri::Manager;
