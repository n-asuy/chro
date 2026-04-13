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
pub mod cli;
mod constants;
mod cors;
mod errors;
mod helpers;
pub(crate) mod identifiers;
mod perf;
mod port_file;
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

pub async fn run(args: ServerArgs) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_target(false)
        .init();

    raise_fd_limit();

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

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}
