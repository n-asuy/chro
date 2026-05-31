//! Resolve a live `webSocketDebuggerUrl` for a Chrome DevTools endpoint.
//!
//! Ported from browser-harness `daemon.py:get_ws_url`. Two real-world quirks
//! drive the shape:
//!
//! * The browser UUID baked into `DevToolsActivePort` goes stale if the same
//!   port was previously used with a different `--user-data-dir`, so the live
//!   URL is resolved through `/json/version` rather than trusted blindly.
//! * Chrome 147+ disables the `/json/*` HTTP endpoints on the default profile;
//!   the `ws` path Chrome writes to `DevToolsActivePort` still works, so that
//!   is the fallback when `/json/version` 404s.

use std::{path::Path, time::Duration};

use crate::error::{BrowserError, Result};

const DISCOVERY_DEADLINE: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Block until the DevTools endpoint on `port` yields a WebSocket URL, reading
/// the `DevToolsActivePort` file in `user_data_dir` as the 404 fallback.
pub async fn resolve_ws_url(port: u16, user_data_dir: &Path) -> Result<String> {
    let user_data_dir = user_data_dir.to_path_buf();
    tokio::task::spawn_blocking(move || resolve_blocking(port, &user_data_dir))
        .await
        .map_err(|e| BrowserError::Discovery(format!("discovery task panicked: {e}")))?
}

fn resolve_blocking(port: u16, user_data_dir: &Path) -> Result<String> {
    let version_url = format!("http://127.0.0.1:{port}/json/version");
    let deadline = std::time::Instant::now() + DISCOVERY_DEADLINE;
    let mut last_err: String;

    loop {
        match ureq::get(&version_url)
            .timeout(Duration::from_secs(2))
            .call()
        {
            Ok(resp) => match resp.into_json::<serde_json::Value>() {
                Ok(body) => {
                    if let Some(url) = body.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                        return Ok(url.to_string());
                    }
                    last_err = "/json/version missing webSocketDebuggerUrl".to_string();
                }
                Err(e) => last_err = format!("/json/version parse failed: {e}"),
            },
            // Chrome 147+ default profile: /json/* is gone (404) but the ws path
            // in DevToolsActivePort still upgrades.
            Err(ureq::Error::Status(404, _)) => {
                if let Some(url) = ws_from_active_port(port, user_data_dir) {
                    return Ok(url);
                }
                last_err = "/json/version returned 404 and DevToolsActivePort had no path".into();
            }
            Err(e) => last_err = e.to_string(),
        }

        if std::time::Instant::now() >= deadline {
            return Err(BrowserError::Discovery(format!(
                "127.0.0.1:{port} unreachable after {}s: {last_err}",
                DISCOVERY_DEADLINE.as_secs()
            )));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Build a `ws://` URL from the `DevToolsActivePort` file when the port matches.
/// The file is two lines: the port, then the browser ws path (`/devtools/...`).
fn ws_from_active_port(want_port: u16, user_data_dir: &Path) -> Option<String> {
    let contents = std::fs::read_to_string(user_data_dir.join("DevToolsActivePort")).ok()?;
    let mut lines = contents.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let ws_path = lines.next()?.trim();
    if port == want_port && !ws_path.is_empty() {
        Some(format!("ws://127.0.0.1:{port}{ws_path}"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_active_port_file() {
        let dir = std::env::temp_dir().join(format!("chro-disco-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("DevToolsActivePort"),
            "9222\n/devtools/browser/abc-123\n",
        )
        .unwrap();

        assert_eq!(
            ws_from_active_port(9222, &dir).as_deref(),
            Some("ws://127.0.0.1:9222/devtools/browser/abc-123")
        );
        // Port mismatch (stale file from a previous launch) → no match.
        assert_eq!(ws_from_active_port(9333, &dir), None);

        std::fs::remove_dir_all(&dir).ok();
    }
}
