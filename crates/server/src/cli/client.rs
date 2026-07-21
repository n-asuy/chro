use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

fn port_file_path() -> PathBuf {
    env::temp_dir().join("chro").join("chro.port")
}

#[derive(Debug)]
pub enum ClientError {
    ServerNotRunning,
    NoGitRepo,
    Http(String),
    Api { status: u16, body: String },
    /// The command was invoked in a way that cannot be resolved (bad or
    /// missing arguments); the message is shown to the user verbatim.
    Usage(String),
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ServerNotRunning => write!(
                f,
                "Chro server is not running. Start it with `chro` or the desktop app."
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
}

impl ServerClient {
    pub fn connect() -> Result<Self, ClientError> {
        let port = read_port_file()?;
        let base_url = format!("http://127.0.0.1:{port}");
        let agent = ureq::Agent::new();

        match agent.get(&format!("{base_url}/health")).call() {
            Ok(_) => {}
            Err(_) => return Err(ClientError::ServerNotRunning),
        }

        Ok(Self { base_url, agent })
    }

    pub fn get(&self, path: &str) -> Result<serde_json::Value, ClientError> {
        let url = format!("{}{path}", self.base_url);
        let resp = self.agent.get(&url).call().map_err(map_ureq_error)?;
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
        let url = format!("{}{path}", self.base_url);
        let resp = self
            .agent
            .post(&url)
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
        let url = format!("{}{path}", self.base_url);
        let resp = self
            .agent
            .request("PATCH", &url)
            .send_json(body.clone())
            .map_err(map_ureq_error)?;
        let response_body: serde_json::Value = resp
            .into_json()
            .map_err(|e| ClientError::Http(e.to_string()))?;
        Ok(response_body)
    }

    pub fn post_no_content(&self, path: &str, body: &serde_json::Value) -> Result<(), ClientError> {
        let url = format!("{}{path}", self.base_url);
        let _resp = self
            .agent
            .post(&url)
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
