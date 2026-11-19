//! Desktop-owned credentials and the transport to a session's remote server.
mod auth;
mod bundle;
pub use auth::{sign_in, status, CloudSettings};
pub use bundle::{git, import_bundle, repository_bundle};

use anyhow::{bail, Context, Result};
use reqwest::{Client, Method};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone)]
pub struct CloudClient {
    client: Client,
    pub settings: CloudSettings,
    token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instance {
    pub id: String,
    pub session_id: String,
    pub state: String,
    pub endpoint: String,
    pub failure_reason: Option<String>,
}

impl CloudClient {
    pub async fn connect() -> Result<Self> {
        let settings = CloudSettings::load()?;
        let credential_settings = settings.clone();
        let token =
            tokio::task::spawn_blocking(move || auth::load_token(&credential_settings)).await??;
        Ok(Self {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(60))
                .build()?,
            settings,
            token,
        })
    }

    pub async fn request(
        &self,
        base: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<reqwest::Response> {
        auth::validate_url(base)?;
        let mut request = self
            .client
            .request(method, format!("{}{path}", base.trim_end_matches('/')))
            .header("Cf-Access-Jwt-Assertion", &self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.context("Cannot reach cloud service")?;
        match response.status().as_u16() {
            200..=299 => Ok(response),
            301 | 302 | 303 | 307 | 308 | 401 | 403 => {
                bail!("Cloud sign-in expired. Sign in again.")
            }
            409 => bail!("Cloud instance limit reached. Stop another cloud session and try again."),
            status => bail!(
                "Cloud service returned {status}: {}",
                response
                    .text()
                    .await
                    .unwrap_or_default()
                    .chars()
                    .take(512)
                    .collect::<String>()
            ),
        }
    }

    pub async fn upload(&self, base: &str, path: &str, bytes: Vec<u8>) -> Result<()> {
        auth::validate_url(base)?;
        let response = self
            .client
            .post(format!("{}{path}", base.trim_end_matches('/')))
            .header("Cf-Access-Jwt-Assertion", &self.token)
            .body(bytes)
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "Cloud repository upload failed ({}). Sign in again if access expired.",
                response.status()
            );
        }
        Ok(())
    }

    pub async fn json<T: DeserializeOwned>(
        &self,
        base: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T> {
        Ok(self.request(base, method, path, body).await?.json().await?)
    }

    pub async fn instance(&self, session_id: &str) -> Result<Instance> {
        let base = &self.settings.control_plane_url;
        let mut instance: Instance = self
            .json(
                base,
                Method::POST,
                "/v1/instances",
                Some(json!({"session_id": session_id})),
            )
            .await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
        loop {
            if instance.session_id != session_id {
                bail!("Cloud returned an instance for another session");
            }
            match instance.state.as_str() {
                "ready" => {
                    auth::validate_url(&instance.endpoint)?;
                    return Ok(instance);
                }
                "sleeping" => {
                    instance = self
                        .json(
                            base,
                            Method::POST,
                            &format!("/v1/instances/{}/wake", instance.id),
                            Some(json!({})),
                        )
                        .await?;
                }
                "failed" | "destroying" => bail!(
                    "Cloud instance {}: {}",
                    instance.state,
                    instance.failure_reason.unwrap_or_default()
                ),
                "provisioning" => {}
                other => bail!("Unknown cloud instance state: {other}"),
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("Cloud instance took too long to become ready. Retry this session.");
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
            instance = self
                .json(
                    base,
                    Method::GET,
                    &format!("/v1/instances/{}", instance.id),
                    None,
                )
                .await?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn per_session_create_carries_access_assertion_and_session_id() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let endpoint = base.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let size = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..size]);
            assert!(request.starts_with("POST /v1/instances HTTP/1.1"));
            assert!(request
                .to_lowercase()
                .contains("cf-access-jwt-assertion: test-token"));
            assert!(request.contains("\"session_id\":\"session-one\""));
            let body = json!({"id": "instance-one", "session_id": "session-one", "state": "ready", "endpoint": endpoint}).to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let client = CloudClient {
            client: Client::new(),
            settings: CloudSettings {
                control_plane_url: base,
                audience: "test".into(),
                transfer_url: "http://127.0.0.1".into(),
            },
            token: "test-token".into(),
        };
        assert_eq!(
            client.instance("session-one").await.unwrap().id,
            "instance-one"
        );
        server.await.unwrap();
    }
}
