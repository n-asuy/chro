//! The operations daemon that runs alongside a chro server.
//!
//! It listens on loopback only. The control plane reaches it through the same
//! private path it uses for the server itself, so this port is never exposed to
//! the internet even though the machine has a public address.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use clap::Parser;

use instance_ops::Quiesced;
use instance_ops::health::{self, ServerProbe};
use instance_ops::quiesce::QuiesceRequest;

#[derive(Parser, Debug)]
#[command(
    name = "chro-instance-ops",
    about = "Operations daemon for a chro instance"
)]
struct Args {
    /// Where to listen. Loopback by default: this daemon answers the control
    /// plane, never the public internet.
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    #[arg(long, default_value_t = 9090)]
    port: u16,

    /// Base URL of the chro server on this machine.
    #[arg(long, default_value = "http://127.0.0.1:8080")]
    server_url: String,

    /// Directory holding the user's work, used to report free space.
    #[arg(long, default_value = "/home/chro/workspace")]
    workspace: String,
}

struct AppState {
    probe: ServerProbe,
    quiesce: QuiesceRequest,
    quiesced: Quiesced,
    workspace: String,
    /// Shared with the control plane at provisioning time. Scoped to this
    /// instance alone: it grants nothing anywhere else, so a compromised
    /// machine cannot reach into the fleet.
    token: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();

    let token = std::env::var("INSTANCE_OPS_TOKEN")
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if token.is_none() {
        // Loopback-only already keeps strangers out; the token is the second
        // layer, and running without it should be a visible choice.
        tracing::warn!("no INSTANCE_OPS_TOKEN set: any local process can drive this daemon");
    }

    let state = Arc::new(AppState {
        probe: ServerProbe::new(args.server_url.clone()),
        quiesce: QuiesceRequest::new(args.server_url),
        quiesced: Quiesced::new(),
        workspace: args.workspace,
        token,
    });

    let app = Router::new()
        .route("/ops/health", get(ops_health))
        .route("/ops/quiesce", post(ops_quiesce))
        .route("/ops/resume", post(ops_resume))
        .with_state(state);

    let addr = format!("{}:{}", args.host, args.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "instance ops listening");

    axum::serve(listener, app).await?;
    Ok(())
}

fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(expected) = &state.token else {
        return true;
    };
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .is_some_and(|given| given == expected)
}

async fn ops_health(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&state, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let report = health::report(&state.probe, &state.quiesced, &state.workspace).await;
    Json(report).into_response()
}

async fn ops_quiesce(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&state, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let outcome = state.quiesce.run(&state.quiesced).await;
    // The status says whether the machine may be stopped, so a caller that
    // reads nothing but the code still cannot lose work.
    let status = if outcome.safe_to_stop() {
        StatusCode::OK
    } else {
        StatusCode::CONFLICT
    };
    (status, Json(outcome)).into_response()
}

async fn ops_resume(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&state, &headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    state.quiesce.resume(&state.quiesced).await;
    StatusCode::NO_CONTENT.into_response()
}
