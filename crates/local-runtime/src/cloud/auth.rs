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
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
        let settings = if let Ok(control_plane_url) = std::env::var("CHRO_CLOUD_CONTROL_PLANE_URL")
        {
            Self {
                control_plane_url,
                audience: std::env::var("CHRO_CLOUD_ACCESS_AUDIENCE")
                    .context("Configure CHRO_CLOUD_ACCESS_AUDIENCE")?,
                transfer_url: std::env::var("CHRO_CLOUD_TRANSFER_URL")
                    .unwrap_or_else(|_| "https://login.cloudflareaccess.org".into()),
            }
        } else {
            serde_json::from_slice(&std::fs::read(settings_path()?).context("Cloud is not configured. Set CHRO_CLOUD_CONTROL_PLANE_URL and CHRO_CLOUD_ACCESS_AUDIENCE.")?)?
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

#[derive(Serialize)]
pub struct CloudStatus {
    pub configured: bool,
    pub signed_in: bool,
    pub message: Option<String>,
}

pub async fn status() -> CloudStatus {
    tokio::task::spawn_blocking(status_blocking)
        .await
        .unwrap_or_else(|error| CloudStatus {
            configured: false,
            signed_in: false,
            message: Some(error.to_string()),
        })
}

fn status_blocking() -> CloudStatus {
    match CloudSettings::load() {
        Err(err) => CloudStatus {
            configured: false,
            signed_in: false,
            message: Some(err.to_string()),
        },
        Ok(settings) => match load_token(&settings) {
            Ok(_) => CloudStatus {
                configured: true,
                signed_in: true,
                message: None,
            },
            Err(err) => CloudStatus {
                configured: true,
                signed_in: false,
                message: Some(err.to_string()),
            },
        },
    }
}

/// Compatible with the Access CLI transfer protocol: ephemeral Curve25519 key,
/// browser approval, long-poll, nonce-prefixed NaCl box. No credential file or
/// organization token is written; only the app token enters the OS keychain.
pub async fn sign_in() -> Result<()> {
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
    open::that(browser.as_str()).context("Cannot open browser for cloud sign-in")?;
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
            .await?;
        if response.status().is_server_error() {
            bail!("Cloud sign-in transfer unavailable. Try signing in again.");
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
        let token = token.to_string();
        tokio::task::spawn_blocking(move || {
            credential(&settings)?
                .set_password(&token)
                .context("Cannot save cloud sign-in in OS keychain")
        })
        .await??;
        return Ok(());
    }
    bail!("Cloud sign-in timed out. Sign in again.")
}

#[cfg(test)]
mod tests {
    use super::*;
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
