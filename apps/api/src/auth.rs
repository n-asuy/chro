use crate::error::{ApiError, ApiResult};
use base64::prelude::*;
use serde::Deserialize;
use serde_json::Value;
use url::Url;
use worker::{console_log, Fetch, Method, Request, RequestInit, RouteContext};

const DEFAULT_CLERK_API_BASE: &str = "https://api.clerk.com";
const ADMIN_SECRET_HEADER: &str = "X-Admin-Secret";

#[derive(Clone, Debug)]
pub struct AuthenticatedUser {
    pub id: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

pub async fn require_user(req: &Request, ctx: &RouteContext<()>) -> ApiResult<AuthenticatedUser> {
    let token = extract_bearer_token(req)?;
    let client = ClerkClient::from_ctx(ctx)?;
    let profile = client.verify_token(&token).await?;

    Ok(AuthenticatedUser {
        id: profile.id.clone(),
        email: profile.primary_email(),
        name: profile.display_name(),
    })
}

pub fn require_admin_secret(req: &Request, ctx: &RouteContext<()>) -> ApiResult<AuthenticatedUser> {
    let provided = req
        .headers()
        .get(ADMIN_SECRET_HEADER)
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::unauthorized("Missing admin secret header"))?;

    let trimmed = provided.trim();
    if trimmed.is_empty() {
        return Err(ApiError::unauthorized("Admin secret header is empty"));
    }

    let expected = ctx
        .secret("ADMIN_SECRET")
        .map_err(|_| ApiError::internal("ADMIN_SECRET is not configured"))?
        .to_string();

    if !secrets_match(trimmed, expected.trim()) {
        return Err(ApiError::unauthorized("Invalid admin secret"));
    }

    Ok(AuthenticatedUser {
        id: "admin".to_string(),
        email: None,
        name: Some("Admin API".to_string()),
    })
}

fn extract_bearer_token(req: &Request) -> ApiResult<String> {
    let header = req
        .headers()
        .get("Authorization")
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::unauthorized("Missing Authorization header"))?;

    let parts: Vec<&str> = header.split_whitespace().collect();
    if parts.len() != 2 || !parts[0].eq_ignore_ascii_case("Bearer") {
        return Err(ApiError::unauthorized(
            "Authorization header must be provided as Bearer <token>",
        ));
    }

    Ok(parts[1].to_string())
}

struct ClerkClient {
    api_base: String,
    secret: String,
}

impl ClerkClient {
    fn from_ctx(ctx: &RouteContext<()>) -> ApiResult<Self> {
        let secret = ctx
            .secret("CLERK_SECRET_KEY")
            .map_err(|_| ApiError::internal("CLERK_SECRET_KEY is not configured"))?
            .to_string();

        Ok(Self {
            api_base: resolve_clerk_api_base(ctx),
            secret,
        })
    }

    async fn verify_token(&self, token: &str) -> ApiResult<ClerkUserProfile> {
        let payload = decode_jwt_payload(token)?;
        let profile = self.fetch_user(&payload.sub).await?;
        Ok(profile)
    }

    async fn fetch_user(&self, user_id: &str) -> ApiResult<ClerkUserProfile> {
        let response = self
            .send(Method::Get, &format!("/v1/users/{user_id}"), None)
            .await?;

        serde_json::from_value(response)
            .map_err(|err| ApiError::internal(format!("Invalid Clerk user payload: {err}")))
    }

    async fn send(&self, method: Method, path: &str, body: Option<String>) -> ApiResult<Value> {
        let mut init = RequestInit::new();
        init.with_method(method);
        if let Some(body) = body {
            init.with_body(Some(body.into()));
        }

        let url = format!(
            "{}/{}",
            self.api_base.trim_end_matches('/'),
            path.trim_start_matches('/')
        );

        let mut request = Request::new_with_init(&url, &init).map_err(ApiError::from)?;
        {
            let headers = request.headers_mut().map_err(ApiError::from)?;
            headers
                .set("Authorization", &format!("Bearer {}", self.secret))
                .map_err(ApiError::from)?;
            headers
                .set("Content-Type", "application/json")
                .map_err(ApiError::from)?;
        }

        let mut response = Fetch::Request(request)
            .send()
            .await
            .map_err(ApiError::from)?;

        if !(200..400).contains(&response.status_code()) {
            let fallback = response.text().await.unwrap_or_default();
            console_log!(
                "[auth] Clerk request failed (status={}): {}",
                response.status_code(),
                fallback
            );
            return Err(ApiError::unauthorized("Unable to validate Clerk token"));
        }

        response.json().await.map_err(ApiError::from)
    }
}

#[derive(Debug, Deserialize)]
struct JwtPayload {
    sub: String,
}

fn decode_jwt_payload(token: &str) -> ApiResult<JwtPayload> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        console_log!("[auth] Invalid JWT structure");
        return Err(ApiError::unauthorized("Invalid bearer token"));
    }

    let payload_bytes = BASE64_URL_SAFE_NO_PAD.decode(parts[1]).map_err(|err| {
        console_log!("[auth] Failed to decode JWT payload: {}", err);
        ApiError::unauthorized("Unable to decode bearer token")
    })?;

    serde_json::from_slice(&payload_bytes).map_err(|err| {
        console_log!("[auth] Failed to parse JWT payload: {}", err);
        ApiError::unauthorized("Malformed bearer token")
    })
}

#[derive(Debug, Deserialize)]
pub struct ClerkUserProfile {
    pub id: String,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
    #[serde(default)]
    primary_email_address_id: Option<String>,
    #[serde(default)]
    email_addresses: Vec<ClerkEmailAddress>,
}

impl ClerkUserProfile {
    pub fn primary_email(&self) -> Option<String> {
        if let Some(primary_id) = &self.primary_email_address_id {
            if let Some(entry) = self
                .email_addresses
                .iter()
                .find(|address| &address.id == primary_id)
            {
                return Some(entry.email_address.clone());
            }
        }

        self.email_addresses
            .first()
            .map(|entry| entry.email_address.clone())
    }

    pub fn display_name(&self) -> Option<String> {
        match (&self.first_name, &self.last_name) {
            (Some(first), Some(last)) => Some(format!("{} {}", first, last)),
            (Some(first), None) => Some(first.clone()),
            (None, Some(last)) => Some(last.clone()),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ClerkEmailAddress {
    id: String,
    email_address: String,
}

fn resolve_clerk_api_base(ctx: &RouteContext<()>) -> String {
    resolve_custom_base(ctx, "CLERK_REST_API_URL")
        .or_else(|| resolve_custom_base(ctx, "CLERK_API_URL"))
        .unwrap_or_else(|| DEFAULT_CLERK_API_BASE.to_string())
}

fn resolve_custom_base(ctx: &RouteContext<()>, key: &str) -> Option<String> {
    let raw = ctx.env.var(key).ok()?.to_string();
    match Url::parse(&raw) {
        Ok(url) if !is_loopback_host(&url) => Some(raw),
        Ok(_) => {
            console_log!("[auth] ignoring {} override pointing to loopback host", key);
            None
        }
        Err(err) => {
            console_log!(
                "[auth] ignoring {} override due to invalid URL '{}': {}",
                key,
                raw,
                err
            );
            None
        }
    }
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host_str() {
        Some(host) => matches!(
            host.to_ascii_lowercase().as_str(),
            "localhost" | "127.0.0.1" | "::1" | "0.0.0.0"
        ),
        None => false,
    }
}

fn secrets_match(provided: &str, expected: &str) -> bool {
    if provided.len() != expected.len() {
        return false;
    }

    let mut diff = 0u8;
    for (a, b) in provided.bytes().zip(expected.bytes()) {
        diff |= a ^ b;
    }

    diff == 0
}
