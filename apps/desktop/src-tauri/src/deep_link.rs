use tauri::{AppHandle, Manager, Runtime as TauriRuntime};
use tauri_plugin_deep_link::DeepLinkExt;
use tracing::info;

/// Wire up the `chro://` URL handler so deep-link arrivals while the app is
/// already running surface the relevant window. The single-instance plugin
/// takes care of the cold-start case by passing argv to the first instance.
pub fn install<R: TauriRuntime>(app: &AppHandle<R>) {
    let app_for_handler = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
        handle_urls(&app_for_handler, urls);
    });
}

pub fn handle_urls<R: TauriRuntime>(app: &AppHandle<R>, urls: Vec<String>) {
    for url in &urls {
        info!("[deep-link] received {url}");
        if let Err(err) = tauri::Emitter::emit(app, "deep-link:url", url.clone()) {
            tracing::warn!("[deep-link] emit failed: {err}");
        }
    }
    if !urls.is_empty() {
        if let Some(window) = primary_window(app) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn primary_window<R: TauriRuntime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.webview_windows().into_values().next()
}
