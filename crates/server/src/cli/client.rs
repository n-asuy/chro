use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

fn port_file_path() -> PathBuf {
    env::temp_dir().join("chro").join("chro.port")
}

/// Base URL of a server to talk to instead of a locally running one.
///
/// When set, the CLI never reads the port file and never expects a server on
/// this machine, so the same commands drive a server reachable over the
/// network.
fn remote_base_url() -> Option<String> {
    if let Some(explicit) = parse_base_url(env::var("CHRO_API_URL").ok().as_deref()) {
        return Some(explicit);
    }

    // Fall back to the instance a control plane is holding for this user, so
    // `chro cloud up` is enough to make the ordinary commands target it. An
    // explicit CHRO_API_URL still wins, and users with no instance are
    // unaffected.
    #[cfg(feature = "cloud")]
    {
        return parse_base_url(super::cloud::endpoint_for_tasks().as_deref());
    }
    #[cfg(not(feature = "cloud"))]
    None
}

/// Bearer token sent with every request when talking to a remote server.
fn remote_api_token() -> Option<String> {
    parse_token(env::var("CHRO_API_TOKEN").ok().as_deref())
}

/// Normalize a configured base URL: blank means "not configured", and a
/// trailing slash is dropped so request paths (which start with one) join
/// cleanly.
fn parse_base_url(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn parse_token(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

#[derive(Debug)]
pub enum ClientError {
    ServerNotRunning,
    NoGitRepo,
    Http(String),
    Api {
        status: u16,
        body: String,
    },
    /// The command was invoked in a way that cannot be resolved (bad or
    /// missing arguments); the message is shown to the user verbatim.
    Usage(String),
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ServerNotRunning => write!(
                f,
                "Chro server is not running. Start the desktop app or run `chro-server`."
            ),
            Self::NoGitRepo => write!(
                f,
                "Not inside a git repository. Use --project to specify one."
            ),
            Self::Http(msg) => write!(f, "HTTP error: {msg}"),
            Self::Api { status, body } => write!(f, "Server responded {status}: {body}"),
            Self::Usage(msg) => write!(f, "{msg}"),
        }
    }
}

pub struct ServerClient {
    base_url: String,
    agent: ureq::Agent,
    auth_token: Option<String>,
}

impl ServerClient {
    pub fn connect() -> Result<Self, ClientError> {
        let agent = ureq::Agent::new();

        let (base_url, auth_token, remote) = match remote_base_url() {
            Some(url) => (url, remote_api_token(), true),
            None => {
                let port = read_port_file()?;
                (format!("http://127.0.0.1:{port}"), None, false)
            }
        };

        let client = Self {
            base_url,
            agent,
            auth_token,
        };

        // A remote server is reached over the network, so a failed health check
        // means something different than a missing local server: report the
        // address so a typo is distinguishable from an unreachable host.
        match client.request("GET", "/health").call() {
            Ok(_) => {}
            Err(err) => {
                return Err(if remote {
                    match err {
                        ureq::Error::Status(status, resp) => ClientError::Api {
                            status,
                            body: resp.into_string().unwrap_or_default(),
                        },
                        ureq::Error::Transport(t) => ClientError::Http(format!(
                            "cannot reach Chro server at {}: {t}",
                            client.base_url
                        )),
                    }
                } else {
                    ClientError::ServerNotRunning
                });
            }
        }

        Ok(client)
    }

    fn request(&self, method: &str, path: &str) -> ureq::Request {
        let url = format!("{}{path}", self.base_url);
        let req = self.agent.request(method, &url);
        match &self.auth_token {
            Some(token) => req.set("Authorization", &format!("Bearer {token}")),
            None => req,
        }
    }

    pub fn get(&self, path: &str) -> Result<serde_json::Value, ClientError> {
        let resp = self.request("GET", path).call().map_err(map_ureq_error)?;
        let body: serde_json::Value = resp
            .into_json()
            .map_err(|e| ClientError::Http(e.to_string()))?;
        Ok(body)
    }

    pub fn post(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        let resp = self
            .request("POST", path)
            .send_json(body.clone())
            .map_err(map_ureq_error)?;
        let response_body: serde_json::Value = resp
            .into_json()
            .map_err(|e| ClientError::Http(e.to_string()))?;
        Ok(response_body)
    }

    pub fn patch(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        let resp = self
            .request("PATCH", path)
            .send_json(body.clone())
            .map_err(map_ureq_error)?;
        let response_body: serde_json::Value = resp
            .into_json()
            .map_err(|e| ClientError::Http(e.to_string()))?;
        Ok(response_body)
    }

    pub fn post_no_content(&self, path: &str, body: &serde_json::Value) -> Result<(), ClientError> {
        let _resp = self
            .request("POST", path)
            .send_json(body.clone())
            .map_err(map_ureq_error)?;
        Ok(())
    }
}

fn map_ureq_error(err: ureq::Error) -> ClientError {
    match err {
        ureq::Error::Status(status, resp) => {
            let body = resp.into_string().unwrap_or_default();
            ClientError::Api { status, body }
        }
        ureq::Error::Transport(t) => ClientError::Http(t.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct ProjectEnvelope {
    pub project: Project,
}

#[derive(Debug, Deserialize)]
pub struct Project {
    pub id: String,
    #[allow(dead_code)]
    pub slug: Option<String>,
    pub git_repo_path: Option<String>,
}

pub fn resolve_project(
    client: &ServerClient,
    project_override: Option<&Path>,
) -> Result<Project, ClientError> {
    let git_root = match project_override {
        Some(path) => path.to_path_buf(),
        None => detect_git_root()?,
    };

    let git_root_str = git_root.to_string_lossy();
    let body = serde_json::json!({ "git_repo_path": git_root_str });
    let resp = client.post("/rpc/projects/ensure", &body)?;
    let envelope: ProjectEnvelope =
        serde_json::from_value(resp).map_err(|e| ClientError::Http(e.to_string()))?;
    Ok(envelope.project)
}

fn read_port_file() -> Result<u16, ClientError> {
    let content =
        fs::read_to_string(port_file_path()).map_err(|_| ClientError::ServerNotRunning)?;
    content
        .trim()
        .parse::<u16>()
        .map_err(|_| ClientError::ServerNotRunning)
}

fn detect_git_root() -> Result<PathBuf, ClientError> {
    let cwd = env::current_dir().map_err(|_| ClientError::NoGitRepo)?;
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output()
        .map_err(|_| ClientError::NoGitRepo)?;

    if !output.status.success() {
        return Err(ClientError::NoGitRepo);
    }

    let path_str = String::from_utf8_lossy(&output.stdout);
    Ok(PathBuf::from(path_str.trim()))
}

#[cfg(test)]
mod tests {
    use super::{parse_base_url, parse_token};

    #[test]
    fn base_url_is_none_when_unset_or_blank() {
        assert_eq!(parse_base_url(None), None);
        assert_eq!(parse_base_url(Some("")), None);
        assert_eq!(parse_base_url(Some("   ")), None);
    }

    #[test]
    fn base_url_drops_trailing_slash_so_paths_join_cleanly() {
        assert_eq!(
            parse_base_url(Some("https://example.dev/")),
            Some("https://example.dev".to_string())
        );
        assert_eq!(
            parse_base_url(Some("  https://example.dev  ")),
            Some("https://example.dev".to_string())
        );
    }

    #[test]
    fn base_url_keeps_port_and_path_prefix() {
        assert_eq!(
            parse_base_url(Some("http://127.0.0.1:4455")),
            Some("http://127.0.0.1:4455".to_string())
        );
        assert_eq!(
            parse_base_url(Some("https://example.dev/chro/")),
            Some("https://example.dev/chro".to_string())
        );
    }

    #[test]
    fn token_is_none_when_unset_or_blank() {
        assert_eq!(parse_token(None), None);
        assert_eq!(parse_token(Some("  ")), None);
        assert_eq!(parse_token(Some(" abc ")), Some("abc".to_string()));
    }
}
