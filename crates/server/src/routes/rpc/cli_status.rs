//! CLI status: resolved path + version for each agent CLI (claude/codex/pi)
//! plus the latest published chro release so the UI can flag a server behind
//! the current release. Powers the right-hand CLI status menu in the title bar.
//!
//! chro's own shell command is deliberately not probed here: the desktop shell
//! registers it as a link to the bundled binary (see the `cli_install` module
//! in apps/desktop/src-tauri), so its state is reported from there, against
//! the user's login-shell PATH rather than this process's.

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
    /// Version this server was built at (`CARGO_PKG_VERSION`).
    server_version: String,
    /// Latest published chro release tag (e.g. `v0.1.40`), when reachable.
    latest_release: Option<String>,
    /// True when this server is behind `latest_release`.
    update_available: bool,
}

async fn get_cli_status(
    State(state): State<AppState>,
) -> Result<Json<CliStatusResponse>, ApiError> {
    let agents = probe_all_agent_clis().await;
    let server_version = env!("CARGO_PKG_VERSION").to_string();
    let latest_release = state.latest_release_cache().get_or_fetch().await;

    let update_available = latest_release
        .as_deref()
        .map(|latest| normalize_version(latest) != normalize_version(&server_version))
        .unwrap_or(false);

    Ok(Json(CliStatusResponse {
        agents,
        server_version,
        latest_release,
        update_available,
    }))
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
