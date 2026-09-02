//! Commands for an instance run by a control plane.
//!
//! These talk to a control plane rather than to a chro server: the control
//! plane creates and stops the machine, and hands back the address the ordinary
//! `task` commands then use. Which control plane is entirely the user's choice
//! — nothing here is bound to a particular operator.

use std::fmt;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::args::CloudCommand;

#[derive(Debug)]
pub enum CloudError {
    NotConfigured,
    NoInstance,
    Http(String),
    Api { status: u16, message: String },
    Config(String),
}

impl fmt::Display for CloudError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => write!(
                f,
                "No control plane configured. Run `chro cloud login <url>` first."
            ),
            Self::NoInstance => write!(f, "No instance yet. Run `chro cloud up` to create one."),
            Self::Http(msg) => write!(f, "HTTP error: {msg}"),
            Self::Api { status, message } => {
                write!(f, "Control plane responded {status}: {message}")
            }
            Self::Config(msg) => write!(f, "{msg}"),
        }
    }
}

type Result<T> = std::result::Result<T, CloudError>;

/// Where the control plane is and how to authenticate to it.
///
/// Stored next to the other per-user state so `chro cloud up` in one shell is
/// visible to `chro task` in another.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudConfig {
    pub control_plane_url: String,
    pub token: String,
}

fn config_path() -> Result<PathBuf> {
    let dir = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| CloudError::Config("cannot locate a data directory".into()))?;
    Ok(dir.join("chro").join("cloud.json"))
}

pub fn load_config() -> Result<CloudConfig> {
    let path = config_path()?;
    let raw = fs::read_to_string(&path).map_err(|_| CloudError::NotConfigured)?;
    serde_json::from_str(&raw)
        .map_err(|e| CloudError::Config(format!("cannot read {}: {e}", path.display())))
}

fn save_config(config: &CloudConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| CloudError::Config(format!("cannot create {}: {e}", parent.display())))?;
    }
    let body = serde_json::to_string_pretty(config)
        .map_err(|e| CloudError::Config(format!("cannot serialize config: {e}")))?;
    fs::write(&path, body)
        .map_err(|e| CloudError::Config(format!("cannot write {}: {e}", path.display())))?;

    // The file holds a bearer token, so keep it readable only by its owner.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct Instance {
    pub id: String,
    pub state: String,
    pub endpoint: Option<String>,
}

struct ControlPlane {
    config: CloudConfig,
    agent: ureq::Agent,
}

impl ControlPlane {
    fn connect() -> Result<Self> {
        Ok(Self {
            config: load_config()?,
            agent: ureq::Agent::new(),
        })
    }

    fn call(&self, method: &str, path: &str) -> Result<serde_json::Value> {
        let url = format!("{}{path}", self.config.control_plane_url);
        let resp = self
            .agent
            .request(method, &url)
            .set("Authorization", &format!("Bearer {}", self.config.token))
            .send_json(serde_json::json!({}));

        match resp {
            Ok(r) => r
                .into_json()
                .map_err(|e| CloudError::Http(e.to_string()))
                .or(Ok(serde_json::Value::Null)),
            Err(ureq::Error::Status(404, _)) => Err(CloudError::NoInstance),
            Err(ureq::Error::Status(status, r)) => {
                let body = r.into_string().unwrap_or_default();
                let message = serde_json::from_str::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("error")?.get("message")?.as_str().map(str::to_string))
                    .unwrap_or(body);
                Err(CloudError::Api { status, message })
            }
            Err(ureq::Error::Transport(t)) => Err(CloudError::Http(format!(
                "cannot reach control plane at {}: {t}",
                self.config.control_plane_url
            ))),
        }
    }

    fn instance(&self, value: serde_json::Value) -> Result<Instance> {
        serde_json::from_value(value)
            .map_err(|e| CloudError::Http(format!("unreadable instance: {e}")))
    }
}

/// Address of the caller's instance, for `task` commands to target.
///
/// Returns `None` rather than an error when no control plane is configured:
/// most users have no cloud instance, and their local server must keep working.
pub fn endpoint_for_tasks() -> Option<String> {
    let cp = ControlPlane::connect().ok()?;
    let value = cp.call("GET", "/v1/instances/me").ok()?;
    cp.instance(value).ok()?.endpoint
}

pub fn run(command: &CloudCommand) -> Result<()> {
    match command {
        CloudCommand::Login { url, token } => {
            let token = token
                .clone()
                .or_else(|| std::env::var("CHRO_CLOUD_TOKEN").ok())
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .ok_or_else(|| {
                    CloudError::Config(
                        "No token given. Pass --token or set CHRO_CLOUD_TOKEN.".into(),
                    )
                })?;

            let config = CloudConfig {
                control_plane_url: url.trim_end_matches('/').to_string(),
                token,
            };
            save_config(&config)?;
            println!("Saved control plane {}", config.control_plane_url);
            Ok(())
        }
        CloudCommand::Up => {
            let cp = ControlPlane::connect()?;

            // Create on first use, wake afterwards: the user asked for a usable
            // instance, not for a particular verb.
            let instance = match cp.call("GET", "/v1/instances/me") {
                Ok(value) => {
                    let existing = cp.instance(value)?;
                    if existing.state == "ready" {
                        existing
                    } else {
                        cp.instance(cp.call("POST", "/v1/instances/me/wake")?)?
                    }
                }
                Err(CloudError::NoInstance) => cp.instance(cp.call("POST", "/v1/instances")?)?,
                Err(err) => return Err(err),
            };

            print_instance(&instance);
            Ok(())
        }
        CloudCommand::Down => {
            let cp = ControlPlane::connect()?;
            let instance = cp.instance(cp.call("POST", "/v1/instances/me/sleep")?)?;
            println!("Instance {} is {}", instance.id, instance.state);
            Ok(())
        }
        CloudCommand::Status => {
            let cp = ControlPlane::connect()?;
            let instance = cp.instance(cp.call("GET", "/v1/instances/me")?)?;
            print_instance(&instance);
            Ok(())
        }
        CloudCommand::Destroy => {
            let cp = ControlPlane::connect()?;
            cp.call("DELETE", "/v1/instances/me")?;
            println!("Instance destroyed");
            Ok(())
        }
    }
}

fn print_instance(instance: &Instance) {
    println!("Instance {}  state:{}", instance.id, instance.state);
    match &instance.endpoint {
        Some(endpoint) => println!("Endpoint: {endpoint}"),
        None => println!("Endpoint: (none while not ready)"),
    }
}
