use anyhow::Context;
use axum::{middleware, Router};
use db::DBService;
use local_runtime::LocalRuntime;
use runtime::{Runtime, RuntimeOptions};
use tower_http::trace::TraceLayer;
use tracing::info;

use args::ServerArgs;
use shutdown::shutdown_signal;

mod app_state;
pub mod args;
mod browser_session;
pub mod cli;
mod constants;
mod cors;
mod errors;
mod helpers;
pub(crate) mod identifiers;
mod parent_watch;
mod perf;
mod port_file;
mod pty;
mod routes;
mod shutdown;

pub(crate) use app_state::AppState;
pub(crate) use constants::MAX_IMAGE_UPLOAD_BYTES;
pub(crate) use errors::ApiError;
pub(crate) use helpers::format_system_time;

#[cfg(unix)]
fn raise_fd_limit() {
    match rlimit::Resource::NOFILE.get() {
        Ok((soft, hard)) => {
            if soft < hard {
                if let Err(e) = rlimit::Resource::NOFILE.set(hard, hard) {
                    tracing::warn!(soft, hard, error = %e, "failed to raise fd limit");
                } else {
                    tracing::info!(previous = soft, current = hard, "raised fd limit");
                }
            } else {
                tracing::debug!(limit = soft, "fd limit already at maximum");
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, "failed to read fd limit");
        }
    }
}

#[cfg(not(unix))]
fn raise_fd_limit() {}

/// Prepend the directory holding the bundled `chro` CLI (provided by the desktop
/// shell via `CHRO_CLI_DIR`) to this process's `PATH`. Executors derive the
/// environment they hand to spawned agents from this `PATH`, so the prepend lets
/// an agent invoke `chro task ...` by bare name instead of hitting "command not
/// found". No-op when the variable is unset (standalone or dev launches) or the
/// directory is already first on `PATH`.
fn expose_cli_on_path() {
    let Some(cli_dir) = std::env::var_os("CHRO_CLI_DIR") else {
        return;
    };
    if let Some(updated) = prepend_path_entry(std::env::var_os("PATH"), &cli_dir) {
        std::env::set_var("PATH", updated);
    }
}

/// Build a `PATH` value with `dir` moved to the front, or `None` when `dir` is
/// empty or already the first entry. Deduplicates so repeated launches do not
/// grow `PATH`.
fn prepend_path_entry(
    current: Option<std::ffi::OsString>,
    dir: &std::ffi::OsStr,
) -> Option<std::ffi::OsString> {
    if dir.is_empty() {
        return None;
    }
    let dir_path = std::path::PathBuf::from(dir);
    let existing: Vec<std::path::PathBuf> = current
        .as_ref()
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    if existing.first() == Some(&dir_path) {
        return None;
    }
    let mut entries = vec![dir_path.clone()];
    entries.extend(existing.into_iter().filter(|p| *p != dir_path));
    std::env::join_paths(entries).ok()
}

pub async fn run(args: ServerArgs) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();

    raise_fd_limit();
    expose_cli_on_path();

    perf::set_perf_enabled(args.perf);

    config::migrate_legacy_dirs();

    // Initialize PostHog analytics (no-op when POSTHOG_API_KEY is unset)
    {
        let config_service = config::ConfigService::new(config::config_path());
        let user_config = config_service.load().unwrap_or_default();
        analytics::init(analytics::AnalyticsConfig {
            distinct_id: user_config.telemetry_id.clone(),
            enabled: user_config.analytics_enabled,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        });
    }

    let log_db_path = args.db_path.clone().unwrap_or_else(DBService::default_path);
    info!(path = %log_db_path.display(), "using sqlite");

    let runtime = LocalRuntime::bootstrap(RuntimeOptions {
        user_id: "desktop".to_string(),
        db_path: args.db_path.clone(),
    })
    .await
    .context("failed to init runtime")?;
    runtime
        .cleanup_orphan_executions()
        .await
        .context("failed to cleanup executions")?;
    let state = AppState::new(runtime.clone());
    let state_pty_handle = state.pty().clone();
    let state_browser_handle = state.browser().clone();
    let listener = tokio::net::TcpListener::bind(format!("{}:{}", args.host, args.port)).await?;
    let actual_port = listener.local_addr()?.port();

    let allowed_origins = cors::AllowedOrigins::load(actual_port)?;
    info!(origins = ?allowed_origins.values(), "configured CORS allowlist");

    let api_routes = Router::new()
        .merge(routes::health_router())
        .merge(routes::sessions_router())
        .nest("/rpc", routes::rpc_router())
        .nest("/streams", routes::streams_router())
        .with_state(state)
        .layer(allowed_origins.layer())
        .layer(middleware::from_fn_with_state(
            allowed_origins.clone(),
            cors::enforce_allowed_origin,
        ));

    let mut app = api_routes
        .fallback(routes::frontend::serve_fallback)
        .layer(TraceLayer::new_for_http());

    if args.perf {
        info!("perf recording enabled - logging to log/performance/");
        perf::init_writer();
        app = app.layer(middleware::from_fn(perf::latency_recorder));
    }

    if let Err(e) = port_file::write_port_file(actual_port).await {
        tracing::warn!("Failed to write port file: {}", e);
    }

    let listen_url = format!("http://{}:{}", args.host, actual_port);
    info!(port = actual_port, "listening on {}", listen_url);

    if !args.no_open {
        let url = listen_url.clone();
        tokio::spawn(async move {
            if let Err(e) = open::that(&url) {
                tracing::warn!("failed to open browser: {e}; open {url} manually");
            }
        });
    }

    let parent_pid = parent_watch::owner_pid_from_env();
    if let Some(pid) = parent_pid {
        info!(
            owner_pid = pid,
            "watching owner process; will shut down if it exits"
        );
    }
    let pty_for_shutdown = state_pty_handle.clone();
    let browser_for_shutdown = state_browser_handle.clone();
    let shutdown = async move {
        tokio::select! {
            _ = shutdown_signal() => info!("received shutdown signal"),
            _ = parent_watch::parent_lost(parent_pid) => {
                info!(parent_pid = ?parent_pid, "owner process exited; shutting down chro-server");
            }
        }
        pty_for_shutdown.shutdown_all().await;
        browser_for_shutdown.shutdown_all().await;
    };
    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown)
        .await?;

    Ok(())
}

#[cfg(test)]
mod cli_path_tests {
    use super::prepend_path_entry;
    use std::ffi::{OsStr, OsString};
    use std::path::PathBuf;

    fn join(parts: &[&str]) -> OsString {
        std::env::join_paths(parts.iter().map(PathBuf::from)).unwrap()
    }

    fn split(value: &OsStr) -> Vec<PathBuf> {
        std::env::split_paths(value).collect()
    }

    #[test]
    fn prepends_cli_dir_to_front() {
        let out =
            prepend_path_entry(Some(join(&["/usr/bin", "/bin"])), OsStr::new("/opt/chro")).unwrap();
        assert_eq!(
            split(&out),
            vec![
                PathBuf::from("/opt/chro"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
    }

    #[test]
    fn moves_existing_entry_to_front_without_duplicating() {
        let out = prepend_path_entry(
            Some(join(&["/usr/bin", "/opt/chro", "/bin"])),
            OsStr::new("/opt/chro"),
        )
        .unwrap();
        assert_eq!(
            split(&out),
            vec![
                PathBuf::from("/opt/chro"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ]
        );
    }

    #[test]
    fn is_noop_when_already_first() {
        assert!(prepend_path_entry(
            Some(join(&["/opt/chro", "/usr/bin"])),
            OsStr::new("/opt/chro")
        )
        .is_none());
    }

    #[test]
    fn is_noop_when_dir_is_empty() {
        assert!(prepend_path_entry(Some(join(&["/usr/bin"])), OsStr::new("")).is_none());
    }

    #[test]
    fn sets_sole_entry_when_path_is_unset() {
        let out = prepend_path_entry(None, OsStr::new("/opt/chro")).unwrap();
        assert_eq!(split(&out), vec![PathBuf::from("/opt/chro")]);
    }
}
