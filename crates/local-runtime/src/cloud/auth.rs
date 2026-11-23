use anyhow::{bail, Context, Result};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use crypto_box::{
    aead::{Aead, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Why a sign-in did not complete, named for what the person can do next.
/// Carried as the error itself (not parsed back out of messages), and sent to
/// the desktop as its snake_case code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInError {
    NotConfigured,
    Unreachable,
    Cancelled,
    TimedOut,
    NotAllowed,
    Failed,
}

impl std::fmt::Display for SignInError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::NotConfigured => "Cloud is not configured",
            Self::Unreachable => "Cannot reach cloud service",
            Self::Cancelled => "Cloud sign-in cancelled",
            Self::TimedOut => "Cloud sign-in timed out. Sign in again.",
            Self::NotAllowed => "This account cannot use cloud sessions",
            Self::Failed => "Could not sign in to Cloud",
        })
    }
}

impl std::error::Error for SignInError {}

impl SignInError {
    fn of(error: &anyhow::Error) -> Self {
        // `downcast_ref` on the anyhow error also finds a value attached with
        // `.context(..)`; the chain finds one wrapped by a later context.
        error
            .downcast_ref::<Self>()
            .or_else(|| error.chain().find_map(|cause| cause.downcast_ref()))
            .copied()
            .unwrap_or(Self::Failed)
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CloudSettings {
    pub control_plane_url: String,
    pub audience: String,
    /// Access's encrypted credential transfer relay, independent of the operator.
    pub transfer_url: String,
}

pub fn validate_url(value: &str) -> Result<Url> {
    let url = Url::parse(value)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && loopback))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("Cloud URL must use HTTPS (HTTP is allowed only on loopback)");
    }
    Ok(url)
}

fn settings_path() -> Result<PathBuf> {
    let base = std::env::var_os("CHRO_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::config_dir().map(|p| p.join("chro")))
        .context("Cannot locate cloud configuration")?;
    Ok(base.join("cloud-settings.json"))
}

impl CloudSettings {
    pub fn load() -> Result<Self> {
        let path = settings_path()?;
        let file = if path.exists() {
            Some(serde_json::from_slice::<Self>(&std::fs::read(path)?)?)
        } else {
            None
        };
        Self::resolve(
            std::env::var("CHRO_CLOUD_CONTROL_PLANE_URL").ok(),
            std::env::var("CHRO_CLOUD_ACCESS_AUDIENCE").ok(),
            std::env::var("CHRO_CLOUD_TRANSFER_URL").ok(),
            file,
            option_env!("CHRO_CLOUD_CONTROL_PLANE_URL"),
            option_env!("CHRO_CLOUD_ACCESS_AUDIENCE"),
        )
    }

    fn resolve(
        url: Option<String>,
        audience: Option<String>,
        transfer: Option<String>,
        file: Option<Self>,
        built_url: Option<&str>,
        built_audience: Option<&str>,
    ) -> Result<Self> {
        let settings = Self {
            control_plane_url: url
                .or_else(|| file.as_ref().map(|s| s.control_plane_url.clone()))
                .or_else(|| {
                    built_url
                        .filter(|s| !s.trim().is_empty())
                        .map(str::to_owned)
                })
                .context(SignInError::NotConfigured)?,
            audience: audience
                .or_else(|| file.as_ref().map(|s| s.audience.clone()))
                .or_else(|| {
                    built_audience
                        .filter(|s| !s.trim().is_empty())
                        .map(str::to_owned)
                })
                .context(SignInError::NotConfigured)?,
            transfer_url: transfer
                .or_else(|| file.map(|s| s.transfer_url))
                .unwrap_or_else(|| "https://login.cloudflareaccess.org".into()),
        };
        validate_url(&settings.control_plane_url)?;
        validate_url(&settings.transfer_url)?;
        if settings.audience.trim().is_empty() {
            bail!("Cloud Access audience is missing");
        }
        Ok(settings)
    }
}

fn credential(settings: &CloudSettings) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(
        "chro-cloud-access",
        settings.control_plane_url.trim_end_matches('/'),
    )?)
}

fn valid_token(token: &str, audience: &str) -> Result<()> {
    let part = token
        .split('.')
        .nth(1)
        .context("Invalid cloud sign-in token")?;
    let payload: serde_json::Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part)?)?;
    let expiry = payload["exp"]
        .as_u64()
        .context("Cloud sign-in token has no expiry")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let aud = &payload["aud"];
    if expiry <= now + 30 {
        bail!("Cloud sign-in expired. Sign in again.");
    }
    if aud.as_str() != Some(audience)
        && !aud
            .as_array()
            .is_some_and(|items| items.iter().any(|v| v.as_str() == Some(audience)))
    {
        bail!("Cloud sign-in token has the wrong audience");
    }
    // The edge verifies the signature and identity on every request. This local
    // check only avoids storing expired tokens or tokens for another application.
    Ok(())
}

pub(super) fn load_token(settings: &CloudSettings) -> Result<String> {
    let token = credential(settings)?
        .get_password()
        .context("Sign in to Cloud first")?;
    valid_token(&token, &settings.audience)?;
    Ok(token)
}

/// Remove the local application credential on sign-out or Access rejection.
pub async fn sign_out() -> Result<()> {
    cancel_sign_in().await;
    attempt().lock().unwrap().error = None;
    let settings = CloudSettings::load()?;
    tokio::task::spawn_blocking(move || {
        let _guard = credential_lock().lock().unwrap();
        match credential(&settings)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error.into()),
        }
    })
    .await?
}

async fn verify_access(settings: &CloudSettings, token: &str) -> Result<()> {
    let response = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?
        .get(format!(
            "{}/v1/instances",
            settings.control_plane_url.trim_end_matches('/')
        ))
        .header("cf-access-token", token)
        .send()
        .await
        .context(SignInError::Unreachable)?;
    match response.status().as_u16() {
        200..=299 => (),
        301 | 302 | 303 | 307 | 308 | 401 | 403 => return Err(SignInError::NotAllowed.into()),
        _ => return Err(SignInError::Unreachable.into()),
    }
    Ok(())
}

#[derive(Default, Serialize)]
pub struct CloudStatus {
    pub configured: bool,
    pub signed_in: bool,
    pub message: Option<String>,
    pub email: Option<String>,
    pub busy: bool,
    pub sign_in_url: Option<String>,
    pub error: Option<SignInError>,
}

pub async fn status() -> CloudStatus {
    tokio::task::spawn_blocking(status_blocking)
        .await
        .unwrap_or_else(|error| CloudStatus {
            configured: false,
            signed_in: false,
            message: Some(error.to_string()),
            ..CloudStatus::default()
        })
}

fn status_blocking() -> CloudStatus {
    let mut status = match CloudSettings::load() {
        Err(err) => CloudStatus {
            configured: false,
            signed_in: false,
            message: Some(err.to_string()),
            error: Some(SignInError::NotConfigured),
            ..CloudStatus::default()
        },
        Ok(settings) => match load_token(&settings) {
            Ok(token) => CloudStatus {
                configured: true,
                signed_in: true,
                message: None,
                email: token_email(&token),
                ..CloudStatus::default()
            },
            Err(err) => CloudStatus {
                configured: true,
                signed_in: false,
                message: Some(err.to_string()),
                ..CloudStatus::default()
            },
        },
    };
    let attempt = attempt().lock().unwrap();
    status.busy = attempt.cancel.is_some();
    status.sign_in_url = attempt.url.clone();
    status.error = status.error.or_else(|| attempt.error.clone());
    status
}

fn token_email(token: &str) -> Option<String> {
    let part = token.split('.').nth(1)?;
    let payload: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).ok()?).ok()?;
    payload["email"].as_str().map(str::to_owned)
}

#[derive(Default)]
struct Attempt {
    cancel: Option<tokio_util::sync::CancellationToken>,
    url: Option<String>,
    error: Option<SignInError>,
}
fn attempt() -> &'static Mutex<Attempt> {
    static ATTEMPT: OnceLock<Mutex<Attempt>> = OnceLock::new();
    ATTEMPT.get_or_init(Default::default)
}
fn credential_lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

pub async fn cancel_sign_in() {
    let mut attempt = attempt().lock().unwrap();
    if let Some(cancel) = attempt.cancel.take() {
        cancel.cancel();
    }
    attempt.url = None;
    attempt.error = Some(SignInError::Cancelled);
}

/// Compatible with the Access CLI transfer protocol: ephemeral Curve25519 key,
/// browser approval, long-poll, nonce-prefixed NaCl box. No credential file or
/// organization token is written; only the app token enters the OS keychain.
pub async fn begin_sign_in() -> Result<()> {
    let settings = CloudSettings::load()?;
    let secret = SecretKey::generate(&mut OsRng);
    let key = URL_SAFE.encode(secret.public_key().as_bytes());
    let mut redirect = validate_url(&settings.control_plane_url)?;
    redirect.set_path("/");
    redirect
        .query_pairs_mut()
        .append_pair("token", &key)
        .append_pair("aud", &settings.audience);
    let mut browser = redirect.clone();
    browser.set_path("/cdn-cgi/access/cli");
    browser
        .query_pairs_mut()
        .append_pair("redirect_url", redirect.as_str())
        .append_pair("send_org_token", "true")
        .append_pair("edge_token_transfer", "true");
    let cancel = tokio_util::sync::CancellationToken::new();
    {
        let mut state = attempt().lock().unwrap();
        if state.cancel.is_some() {
            return Ok(());
        }
        state.cancel = Some(cancel.clone());
        state.url = Some(browser.to_string());
        state.error = None;
    }
    // The URL remains available for copying if the OS cannot launch a browser.
    let _ = open::that(browser.as_str());
    tokio::spawn(async move {
        let result = tokio::select! {
            _ = cancel.cancelled() => return,
            result = tokio::time::timeout(Duration::from_secs(600), finish_sign_in(settings, secret, key, cancel.clone())) => {
                result.unwrap_or_else(|_| Err(SignInError::TimedOut.into()))
            }
        };
        let mut state = attempt().lock().unwrap();
        if !cancel.is_cancelled() {
            state.cancel = None;
            state.url = None;
            state.error = result.err().map(|e| SignInError::of(&e));
        }
    });
    Ok(())
}

/// CLI callers keep the runtime alive until the transfer has settled.
pub async fn sign_in() -> Result<()> {
    begin_sign_in().await?;
    loop {
        let status = status().await;
        if !status.busy {
            if status.signed_in {
                return Ok(());
            }
            return Err(status.error.unwrap_or(SignInError::Failed).into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn finish_sign_in(
    settings: CloudSettings,
    secret: SecretKey,
    key: String,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(60))
        .build()?;
    for _ in 0..10 {
        let response = client
            .get(format!(
                "{}/transfer/{key}",
                settings.transfer_url.trim_end_matches('/')
            ))
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) if error.is_timeout() => continue,
            Err(error) => return Err(error).context(SignInError::Unreachable),
        };
        if response.status().is_server_error() {
            return Err(SignInError::Unreachable.into());
        }
        if response.status() != reqwest::StatusCode::OK {
            tokio::time::sleep(Duration::from_millis(250)).await;
            continue;
        }
        let peer = URL_SAFE.decode(
            response
                .headers()
                .get("service-public-key")
                .context("Missing transfer key")?
                .to_str()?,
        )?;
        let peer: [u8; 32] = peer
            .try_into()
            .map_err(|_| anyhow::anyhow!("Invalid transfer key"))?;
        let encrypted = STANDARD.decode(response.text().await?.trim())?;
        if encrypted.len() < 40 {
            bail!("Invalid encrypted sign-in response");
        }
        let cipher = SalsaBox::new(&PublicKey::from(peer), &secret);
        let decrypted = cipher
            .decrypt(encrypted[..24].into(), &encrypted[24..])
            .map_err(|_| anyhow::anyhow!("Cannot decrypt cloud sign-in response"))?;
        let value: serde_json::Value = serde_json::from_slice(&decrypted)?;
        let token = value["app_token"]
            .as_str()
            .context("Missing application token")?;
        valid_token(token, &settings.audience)?;
        verify_access(&settings, token).await?;
        let token = token.to_string();
        tokio::task::spawn_blocking(move || {
            let _guard = credential_lock().lock().unwrap();
            if cancel.is_cancelled() {
                return Err(SignInError::Cancelled.into());
            }
            credential(&settings)?
                .set_password(&token)
                .context("Cannot save cloud sign-in in OS keychain")
        })
        .await??;
        return Ok(());
    }
    Err(SignInError::TimedOut.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configuration_precedence_and_unavailable_build() {
        let resolve = |url, audience, file| {
            CloudSettings::resolve(
                url,
                audience,
                None,
                file,
                Some("https://official.example.test"),
                Some("official"),
            )
        };
        let built = resolve(None, None, None).unwrap();
        assert_eq!(built.audience, "official");
        assert_eq!(built.control_plane_url, "https://official.example.test");
        let file = CloudSettings {
            control_plane_url: "https://file.example.test".into(),
            audience: "file".into(),
            transfer_url: "https://relay.example.test".into(),
        };
        let settings = resolve(
            Some("http://127.0.0.1:9000".into()),
            None,
            Some(file.clone()),
        )
        .unwrap();
        assert_eq!(settings.audience, "file");
        assert_eq!(settings.control_plane_url, "http://127.0.0.1:9000");
        let settings = resolve(None, Some("env".into()), Some(file)).unwrap();
        assert_eq!(settings.audience, "env");
        assert_eq!(settings.control_plane_url, "https://file.example.test");
        assert!(CloudSettings::resolve(None, None, None, None, None, None).is_err());
        assert!(CloudSettings::resolve(None, None, None, None, Some(""), Some("")).is_err());
    }
    #[tokio::test]
    async fn verification_sends_client_token_and_distinguishes_edge_from_outage() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (status, expected) in [
            (200, None),
            (403, Some(SignInError::NotAllowed)),
            (302, Some(SignInError::NotAllowed)),
            (503, Some(SignInError::Unreachable)),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let edge = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0; 4096];
                let n = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..n]).to_lowercase();
                assert!(request.contains("cf-access-token: application-token\r\n"));
                assert!(!request.contains("cf-access-jwt-assertion"));
                socket.write_all(format!("HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            });
            let settings = CloudSettings {
                control_plane_url: format!("http://{address}"),
                audience: "app".into(),
                transfer_url: "https://example.test".into(),
            };
            let result = verify_access(&settings, "application-token").await;
            assert_eq!(result.err().as_ref().map(SignInError::of), expected);
            edge.await.unwrap();
        }
    }
    #[test]
    fn sign_in_errors_survive_context_and_reach_the_desktop_as_codes() {
        let wrapped = Err::<(), _>(SignInError::NotAllowed)
            .context("while verifying")
            .unwrap_err();
        assert_eq!(SignInError::of(&wrapped), SignInError::NotAllowed);
        let as_context = Err::<(), _>(std::io::Error::other("refused"))
            .context(SignInError::Unreachable)
            .unwrap_err();
        assert_eq!(SignInError::of(&as_context), SignInError::Unreachable);
        assert_eq!(
            SignInError::of(&anyhow::anyhow!("keychain locked")),
            SignInError::Failed
        );
        assert_eq!(
            serde_json::to_value(SignInError::TimedOut).unwrap(),
            "timed_out"
        );
    }
    #[test]
    fn email_comes_from_application_token() {
        let token = format!(
            "e30.{}.sig",
            URL_SAFE_NO_PAD.encode(br#"{"email":"user@example.test"}"#)
        );
        assert_eq!(token_email(&token).as_deref(), Some("user@example.test"));
        assert_eq!(token_email("bad"), None);
    }
    #[test]
    fn accepts_only_secure_or_loopback_urls() {
        for url in ["https://example.test", "http://127.0.0.1:9999"] {
            assert!(validate_url(url).is_ok());
        }
        for url in [
            "http://example.test",
            "https://user:secret@example.test",
            "file:///tmp/x",
            "https://example.test?token=x",
        ] {
            assert!(validate_url(url).is_err());
        }
    }
    #[test]
    fn expiry_and_audience_are_checked() {
        let token = |exp, aud| {
            format!(
                "e30.{}.signature",
                URL_SAFE_NO_PAD.encode(
                    serde_json::to_vec(&serde_json::json!({"exp": exp, "aud": [aud]})).unwrap()
                )
            )
        };
        assert!(valid_token(&token(u64::MAX, "app"), "app").is_ok());
        assert!(valid_token(&token(0, "app"), "app").is_err());
        assert!(valid_token(&token(u64::MAX, "other"), "app").is_err());
    }
}
