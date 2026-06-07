pub mod commands;
pub mod deep_link;
pub mod error;
pub mod menu;
pub mod runtime;
pub mod tray;
pub mod windows;

use std::{env, path::PathBuf};

use tauri::{AppHandle, Manager, RunEvent, Runtime as TauriRuntime, WebviewWindow, WindowEvent};
use tracing::{info, warn};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

use crate::runtime::server::{launch_runtime, LaunchOptions, ServerState};
use crate::runtime::{
    migrate_legacy_user_data, shared_user_data_dir, user_data_dir_overridden, WindowPool,
};
use crate::windows::{create_renderer_window, RendererWindowOptions, WindowMode};

pub fn run() {
    init_tracing();

    let user_data_dir = match shared_user_data_dir() {
        Ok(dir) => {
            if !user_data_dir_overridden() {
                migrate_legacy_user_data(dir.parent().unwrap_or(&dir));
            }
            dir
        }
        Err(err) => {
            eprintln!("Failed to resolve user data directory: {err:#}");
            std::process::exit(1);
        }
    };

    let mut builder = tauri::Builder::default();

    if !env_flag("CHRO_DISABLE_SINGLE_INSTANCE") {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            info!("[single-instance] received: {argv:?}");
            // Re-deliver any deep-link URLs that came in via argv to the
            // running instance so chro://... navigations don't get lost.
            let urls: Vec<String> = argv
                .into_iter()
                .filter(|a| a.starts_with("chro://"))
                .collect();
            if !urls.is_empty() {
                deep_link::handle_urls(app, urls);
            } else if let Some(window) = app.webview_windows().into_values().next() {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    #[allow(unused_mut)]
    let mut builder = builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .manage(WindowPool::new())
        .manage(ServerState::new(user_data_dir.clone()))
        .invoke_handler(tauri::generate_handler![
            commands::get_version,
            commands::get_runtime_info,
            commands::select_workspace,
            commands::open_project_window,
            commands::show_file_context_menu,
            commands::set_window_mode,
            commands::show_notification,
            commands::open_external_url,
            commands::open_path,
            commands::open_in_cmux,
            commands::install_executor,
            commands::update_check,
            commands::update_download,
            commands::update_install,
            tray::tray_update,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let runtime_dir = user_data_dir.clone();
            deep_link::install(&handle);

            // Build the tray as soon as the app is ready. We do this before
            // launching the runtime so the user has visible feedback that the
            // app is starting up.
            if let Err(err) = tray::install_tray(&handle) {
                warn!("[setup] failed to install tray: {err:#}");
            }

            // Spawn chro-server + the initial session window asynchronously
            // so the UI thread isn't blocked on the health check.
            tauri::async_runtime::spawn(async move {
                if let Err(err) = bootstrap_runtime(handle.clone(), runtime_dir).await {
                    warn!("[setup] bootstrap failed: {err:#}");
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(true) => {
                let label = window.label().to_string();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    on_window_focused(&app, &label).await;
                });
            }
            WindowEvent::Destroyed => {
                let label = window.label().to_string();
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    on_window_destroyed(&app, &label).await;
                });
            }
            _ => {}
        });

    // macOS: own the menu bar so ⌘W closes the active tab instead of the
    // window. The accelerator is intercepted by the native menu before the
    // webview, so this can't live in the renderer.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|handle| menu::build_app_menu(handle))
            .on_menu_event(|app, event| {
                menu::handle_menu_event(app, event.id().0.as_str());
            });
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    let registry_for_exit = app.handle().clone();
    app.run(move |_app, event| match event {
        RunEvent::ExitRequested { .. } => {
            tracing::info!("[lifecycle] exit requested");
            let handle = registry_for_exit.clone();
            tauri::async_runtime::block_on(async move {
                let state = handle.state::<ServerState>();
                state.registry.kill_all().await;
            });
        }
        _ => {}
    });
}

fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

async fn bootstrap_runtime<R: TauriRuntime>(
    app: AppHandle<R>,
    runtime_dir: PathBuf,
) -> anyhow::Result<()> {
    let runtime = launch_runtime(
        app.clone(),
        LaunchOptions {
            dir: runtime_dir,
            use_default_config_path: true,
        },
    )
    .await?;

    {
        let state = app.state::<ServerState>();
        state.registry.insert(runtime.clone()).await;
    }

    create_renderer_window(
        &app,
        &runtime,
        RendererWindowOptions {
            initial_mode: WindowMode::Session,
            route_path: None,
            workspace_path: None,
        },
    )
    .await?;

    Ok(())
}

async fn on_window_focused<R: TauriRuntime>(app: &AppHandle<R>, label: &str) {
    let pool = app.state::<WindowPool>();
    pool.set_active(Some(label.to_string())).await;
    tray::refresh_menu(app).await;
}

async fn on_window_destroyed<R: TauriRuntime>(app: &AppHandle<R>, label: &str) {
    let pool = app.state::<WindowPool>();
    let removed = pool.remove(label).await;
    pool.set_active(None).await;
    if let Some(meta) = removed {
        // Drop the runtime if nothing else references it AND no other windows
        // are open. The "any open window" guard matches the Electron behavior
        // where untracked `window.open()` children can still need the backend.
        if !pool.runtime_in_use(&meta.runtime_id).await && app.webview_windows().is_empty() {
            let state = app.state::<ServerState>();
            if let Some(runtime) = state.registry.remove(&meta.runtime_id).await {
                runtime.kill().await;
            }
        }
    }
    tray::refresh_menu(app).await;
}

fn init_tracing() {
    let filter = EnvFilter::try_from_env("CHRO_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,chro_desktop_lib=debug,chro_server=info"));
    let _ = tracing_subscriber::registry()
        .with(fmt::layer().with_target(true))
        .with(filter)
        .try_init();
}

/// Suppress dead-code warning while WebviewWindow is referenced via traits.
#[allow(dead_code)]
fn _keep_webview_window_in_scope<R: TauriRuntime>(_: WebviewWindow<R>) {}
