//! CLI status: resolved path + version for each agent CLI (claude/codex/pi)
//! and for chro's own CLI, plus the latest published chro release so the UI can
//! flag version drift. Powers the right-hand CLI status menu in the title bar.
//!
//! The chro-CLI-vs-latest comparison is the load-bearing check: a stale `chro`
//! binary shadowing the intended one on PATH silently breaks CLI-resolved
//! features, so surfacing the drift is the fix.

use std::time::{Duration, Instant};

use axum::{extract::State, routing::get, Json, Router};
use executors::cli_status::{probe_all_agent_clis, CliStatus};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{ApiError, AppState};

const GITHUB_LATEST_RELEASE_URL: &str = "https://api.github.com/repos/n-asuy/chro/releases/latest";
/// GitHub's unauthenticated rate limit is low, so the latest tag is cached and
/// only refreshed when the cache is cold or expired (or on explicit refresh).
const LATEST_RELEASE_TTL: Duration = Duration::from_secs(6 * 60 * 60);

pub(super) fn router() -> Router<AppState> {
    Router::new().route("/cli-status", get(get_cli_status))
}

#[derive(Debug, Serialize)]
struct CliStatusResponse {
    /// Agent CLIs (claude, codex, pi).
    agents: Vec<CliStatus>,
    /// chro's own CLI on PATH, if resolvable.
    chro_cli: CliStatus,
    /// Version this server was built at (`CARGO_PKG_VERSION`).
    server_version: String,
    /// Latest published chro release tag (e.g. `v0.1.40`), when reachable.
    latest_release: Option<String>,
    /// True when a chro version (CLI or server) is behind `latest_release`.
    update_available: bool,
}

async fn get_cli_status(
    State(state): State<AppState>,
) -> Result<Json<CliStatusResponse>, ApiError> {
    let agents = probe_all_agent_clis().await;
    let chro_cli = probe_chro_cli().await;
    let server_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_release = state.latest_release_cache().get_or_fetch().await;

    let update_available = match latest_release.as_deref() {
        Some(latest) => {
            let latest_norm = normalize_version(latest);
            let server_behind = normalize_version(&server_version) != latest_norm;
            let cli_behind = chro_cli
                .version
                .as_deref()
                .map(|v| normalize_version(v) != latest_norm)
                .unwrap_or(false);
            server_behind || cli_behind
        }
        None => false,
    };

    Ok(Json(CliStatusResponse {
        agents,
        chro_cli,
        server_version,
        latest_release,
        update_available,
    }))
}

/// Probe the `chro` CLI on PATH. Reuses the same version-probe shape as the
/// agent CLIs but resolves via `which chro` since chro has no manifest entry.
async fn probe_chro_cli() -> CliStatus {
    executors::cli_status::probe_named("chro", "chro").await
}

/// Strip a leading `v` and keep just the first whitespace-delimited token so
/// `v0.1.40`, `0.1.40`, and `chro 0.1.40` compare equal.
fn normalize_version(raw: &str) -> String {
    let token = raw.split_whitespace().last().unwrap_or(raw).trim();
    token.strip_prefix('v').unwrap_or(token).to_string()
}

/// Time-bounded cache for the latest release tag, shared on `AppState`.
#[derive(Default)]
pub struct LatestReleaseCache {
    inner: Mutex<Option<CachedRelease>>,
}

struct CachedRelease {
    tag: Option<String>,
    fetched_at: Instant,
}

impl LatestReleaseCache {
    pub fn new() -> Self {
        Self::default()
    }

    async fn get_or_fetch(&self) -> Option<String> {
        {
            let guard = self.inner.lock().await;
            if let Some(cached) = guard.as_ref() {
                if cached.fetched_at.elapsed() < LATEST_RELEASE_TTL {
                    return cached.tag.clone();
                }
            }
        }

        let tag = fetch_latest_release_tag().await;
        let mut guard = self.inner.lock().await;
        *guard = Some(CachedRelease {
            tag: tag.clone(),
            fetched_at: Instant::now(),
        });
        tag
    }
}

async fn fetch_latest_release_tag() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("chro-desktop")
        .build()
        .ok()?;
    let resp = client
        .get(GITHUB_LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let body: serde_json::Value = resp.json().await.ok()?;
    body.get("tag_name")
        .and_then(|v| v.as_str())
        .map(str::to_string)
}
