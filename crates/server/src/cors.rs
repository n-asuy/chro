use std::{collections::BTreeSet, env, sync::Arc};

use anyhow::Context;
use axum::{
    extract::{Request, State},
    http::{header, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::warn;

pub(crate) const ALLOWED_ORIGINS_ENV: &str = "CHRO_ALLOWED_ORIGINS";

/// Origins the renderer can legitimately talk to us from. The packaged app's
/// origin depends on how the platform's webview serves the custom protocol:
/// macOS and Linux keep the custom scheme (`tauri://localhost`), while the
/// Windows and Android webviews have no custom-scheme support and serve it over
/// `http://<scheme>.localhost` instead (`https://` when the webview opts into
/// the secure scheme). Every packaged origin must be listed, or that platform's
/// renderer is refused on every API call and websocket.
const DEFAULT_ALLOWED_ORIGINS: &[&str] = &[
    "http://localhost:3400",
    "http://127.0.0.1:3400",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
];

#[derive(Clone, Debug)]
pub(crate) struct AllowedOrigins {
    values: Arc<Vec<String>>,
    header_values: Arc<Vec<HeaderValue>>,
}

impl AllowedOrigins {
    pub(crate) fn load(server_port: u16) -> anyhow::Result<Self> {
        let mut origins = BTreeSet::new();

        for origin in DEFAULT_ALLOWED_ORIGINS {
            origins.insert((*origin).to_string());
        }

        // Allow same-origin requests from the embedded frontend
        origins.insert(format!("http://localhost:{}", server_port));
        origins.insert(format!("http://127.0.0.1:{}", server_port));

        if let Ok(raw) = env::var(ALLOWED_ORIGINS_ENV) {
            for origin in split_origins(&raw) {
                origins.insert(origin);
            }
        }

        let values = origins.into_iter().collect::<Vec<_>>();
        let header_values = values
            .iter()
            .map(|origin| {
                HeaderValue::from_str(origin).with_context(|| {
                    format!(
                        "invalid origin '{}' configured via {}",
                        origin, ALLOWED_ORIGINS_ENV
                    )
                })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;

        Ok(Self {
            values: Arc::new(values),
            header_values: Arc::new(header_values),
        })
    }

    pub(crate) fn layer(&self) -> CorsLayer {
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(self.header_values.as_ref().clone()))
            .allow_methods([
                Method::GET,
                Method::POST,
                Method::PUT,
                Method::PATCH,
                Method::DELETE,
                Method::OPTIONS,
            ])
            .allow_headers([
                header::CONTENT_TYPE,
                header::AUTHORIZATION,
                HeaderName::from_static("x-perf-request-id"),
            ])
    }

    pub(crate) fn values(&self) -> &[String] {
        self.values.as_ref().as_slice()
    }

    fn contains(&self, origin: &str) -> bool {
        self.values.iter().any(|allowed| allowed == origin)
    }
}

pub(crate) async fn enforce_allowed_origin(
    State(allowed_origins): State<AllowedOrigins>,
    request: Request,
    next: Next,
) -> Response {
    if let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(normalize_origin)
    {
        if !allowed_origins.contains(&origin) {
            warn!(origin, path = %request.uri().path(), "blocked disallowed cross-origin request");
            return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
        }
    }

    next.run(request).await
}

fn split_origins(raw: &str) -> impl Iterator<Item = String> + '_ {
    raw.split(',').filter_map(|origin| {
        let normalized = normalize_origin(origin);
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        }
    })
}

fn normalize_origin(origin: &str) -> String {
    origin.trim().trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_origins_include_packaged_tauri_origin() {
        std::env::remove_var(ALLOWED_ORIGINS_ENV);

        let origins = AllowedOrigins::load(4410).expect("load allowed origins");

        assert!(origins.values().contains(&"tauri://localhost".to_string()));
    }

    /// The packaged renderer's origin is platform-dependent. Missing one locks
    /// that platform out of every API call and websocket with an opaque
    /// "Failed to fetch", because the origin guard rejects the request before
    /// the CORS layer can attach `Access-Control-Allow-Origin`.
    #[test]
    fn default_origins_cover_every_packaged_webview_origin() {
        std::env::remove_var(ALLOWED_ORIGINS_ENV);

        let origins = AllowedOrigins::load(4410).expect("load allowed origins");

        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ] {
            assert!(
                origins.contains(origin),
                "packaged webview origin {origin} must be allowed"
            );
        }
    }

    #[test]
    fn unknown_origin_is_not_allowed() {
        std::env::remove_var(ALLOWED_ORIGINS_ENV);

        let origins = AllowedOrigins::load(4410).expect("load allowed origins");

        assert!(!origins.contains("https://evil.example"));
    }
}
