use anyhow::{Context, Result};
use serde_json::json;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime as TauriRuntime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tracing::warn;
use uuid::Uuid;

use super::presets::{normalize_route_path, preset_for, WindowMode, WindowPreset};
use crate::runtime::pool::WindowMeta;
use crate::runtime::server::{platform_string, RuntimeContext};
use crate::runtime::WindowPool;

/// Options for spawning a new renderer window.
pub struct RendererWindowOptions {
    pub initial_mode: WindowMode,
    pub route_path: Option<String>,
    pub workspace_path: Option<String>,
}

impl Default for RendererWindowOptions {
    fn default() -> Self {
        Self {
            initial_mode: WindowMode::Onboarding,
            route_path: None,
            workspace_path: None,
        }
    }
}

/// Create a new webview window backed by `runtime`. The renderer is loaded
/// from the Vite dev server in development and from the bundled assets in
/// production; Tauri picks the right URL based on `frontendDist`/`devUrl`.
pub async fn create_renderer_window<R: TauriRuntime>(
    app: &AppHandle<R>,
    runtime: &RuntimeContext,
    options: RendererWindowOptions,
) -> Result<WebviewWindow<R>> {
    let label = format!("window-{}", Uuid::new_v4().simple());
    let route = normalize_route_path(options.route_path.as_deref());
    let preset = preset_for(options.initial_mode);

    let runtime_info = json!({
        "runtimeId": runtime.id,
        "backendUrl": runtime.base_url,
        "workspacePath": options.workspace_path,
        "platform": platform_string(),
    });
    let init_script = format!(
        "(()=>{{try{{Object.defineProperty(window,'__CHRO_RUNTIME__',{{value:{info},writable:false,configurable:false}});}}catch(e){{window.__CHRO_RUNTIME__={info};}}}})();",
        info = runtime_info,
    );

    let url = WebviewUrl::App(route.trim_start_matches('/').into());
    let mut builder = WebviewWindowBuilder::new(app, label.clone(), url)
        .title("Chro")
        .visible(false)
        .resizable(preset.fixed_size.is_none())
        .min_inner_size(preset.min_window_width as f64, preset.min_window_height as f64)
        // Tauri's native OS-level drag-drop handler is enabled by default and
        // swallows drag events before they reach the webview's DOM, so HTML5
        // `dragover`/`drop`/`dataTransfer` never fire. Disabling it lets the
        // renderer's own drop handlers (image uploads, file tree, prompt
        // editor) receive native drag-drop events like the browser build does.
        .disable_drag_drop_handler()
        .initialization_script(&init_script);

    #[cfg(target_os = "macos")]
    {
        // Overlay keeps the traffic lights but, unlike Electron's hiddenInset,
        // does NOT hide the title text on its own — it only makes the title bar
        // transparent with a full-size content view. `hidden_title(true)` is the
        // separate switch that hides the title text, so the window keeps its
        // "Chro" title for the OS (Mission Control, window menu) without
        // painting it over the React header.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let bounds = calculate_window_bounds(app, preset);
    builder = builder.inner_size(bounds.width as f64, bounds.height as f64);
    if let Some((x, y)) = bounds.position {
        builder = builder.position(x as f64, y as f64);
    } else {
        builder = builder.center();
    }

    let window = builder.build().context("build webview window")?;
    apply_constraints(&window, preset);

    if preset.fixed_size.is_some() {
        let _ = window.set_resizable(false);
    }

    // Show after the renderer finishes its initial layout so the first paint
    // doesn't flash an empty frame.
    window.show().ok();
    window.set_focus().ok();

    let pool = app.state::<WindowPool>();
    pool.register(WindowMeta {
        label: label.clone(),
        runtime_id: runtime.id.clone(),
        workspace_path: options.workspace_path.clone(),
        workspace_key: options
            .workspace_path
            .as_deref()
            .and_then(crate::runtime::pool::normalize_workspace_path_for_key),
        mode: options.initial_mode,
    })
    .await;

    Ok(window)
}

#[derive(Debug, Clone, Copy)]
struct WindowBounds {
    width: u32,
    height: u32,
    position: Option<(i32, i32)>,
}

/// Match the Electron build's center-on-work-area math. We use the primary
/// monitor as a starting point since Tauri doesn't expose a "matching display
/// for current cursor" API at the moment the window has not yet been created.
fn calculate_window_bounds<R: TauriRuntime>(
    app: &AppHandle<R>,
    preset: WindowPreset,
) -> WindowBounds {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok().and_then(|mons| mons.into_iter().next()));

    let (work_x, work_y, work_w, work_h) = match monitor.as_ref() {
        Some(m) => {
            let size = m.size();
            let pos = m.position();
            let scale = m.scale_factor();
            // Convert physical pixels to logical pixels so dimension math
            // matches the macOS/HiDPI behavior the Electron build relied on.
            let lw = (size.width as f64 / scale) as i32;
            let lh = (size.height as f64 / scale) as i32;
            let lx = (pos.x as f64 / scale) as i32;
            let ly = (pos.y as f64 / scale) as i32;
            (lx, ly, lw.max(1), lh.max(1))
        }
        None => (0, 0, 1440, 900),
    };

    if let Some((fw, fh)) = preset.fixed_size {
        let cx = work_x + (work_w - fw as i32) / 2;
        let cy = work_y + (work_h - fh as i32) / 2;
        return WindowBounds {
            width: fw,
            height: fh,
            position: Some((cx, cy)),
        };
    }

    let ideal_w = (work_w as f64 * preset.width_ratio) as i32;
    let ideal_h = (work_h as f64 * preset.height_ratio) as i32;
    let w = ideal_w
        .max(preset.min_width as i32)
        .min(work_w)
        .max(1);
    let h = ideal_h
        .max(preset.min_height as i32)
        .min(work_h)
        .max(1);
    let cx = work_x + (work_w - w) / 2;
    let cy = work_y + (work_h - h) / 2;
    WindowBounds {
        width: w as u32,
        height: h as u32,
        position: Some((cx, cy)),
    }
}

pub fn apply_constraints<R: TauriRuntime>(window: &WebviewWindow<R>, preset: WindowPreset) {
    if let Err(err) = window.set_min_size(Some(LogicalSize::new(
        preset.min_window_width as f64,
        preset.min_window_height as f64,
    ))) {
        warn!("[windows] set_min_size failed: {err}");
    }

    if let Some((fw, fh)) = preset.fixed_size {
        if let Err(err) = window.set_size(LogicalSize::new(fw as f64, fh as f64)) {
            warn!("[windows] set_size failed: {err}");
        }
        let _ = window.set_resizable(false);
    } else {
        let _ = window.set_resizable(true);
    }

    // Helper to silence unused warnings for the LogicalPosition import that we
    // may or may not use depending on call site.
    let _ = LogicalPosition::<f64>::new(0.0, 0.0);
}

/// Apply mode change to an existing window (recalculates bounds + constraints).
pub fn set_window_mode<R: TauriRuntime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    mode: WindowMode,
) {
    let preset = preset_for(mode);
    apply_constraints(window, preset);
    let bounds = calculate_window_bounds(app, preset);
    if let Err(err) = window.set_size(LogicalSize::new(
        bounds.width as f64,
        bounds.height as f64,
    )) {
        warn!("[windows] set_size failed: {err}");
    }
    if let Some((x, y)) = bounds.position {
        let _ = window.set_position(LogicalPosition::new(x as f64, y as f64));
    }
}
