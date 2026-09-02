//! Dev-only activity recording.
//!
//! Two halves of the same feature: a middleware over the whole RPC router, so
//! every backend-visible user action is recorded without instrumenting call
//! sites one by one, and the ingest endpoint the renderer flushes its own
//! events to. Both write to [`analytics::dev`], which never transmits.

use analytics::dev::{self, DevEvent, Source};
use axum::{
    extract::{OriginalUri, Request},
    http::StatusCode,
    middleware::Next,
    response::Response,
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Instant;

use crate::{perf, AppState};

/// Recording the ingest call itself would make the renderer's own flushes the
/// loudest signal in the log.
const INGEST_ROUTE: &str = "/dev-events";

/// Liveness polling is not user activity.
const HEALTH_PATH: &str = "/health";

/// Upper bound on one renderer flush, so a runaway client cannot pin the
/// writer thread.
const MAX_EVENTS_PER_REQUEST: usize = 1_000;

pub(super) fn router() -> Router<AppState> {
    Router::new().route(INGEST_ROUTE, post(ingest))
}

#[derive(Debug, Deserialize)]
struct IngestRequest {
    /// Identifies one renderer page load, so events can be grouped by app run.
    session: String,
    events: Vec<IncomingEvent>,
}

#[derive(Debug, Deserialize)]
struct IncomingEvent {
    event: String,
    #[serde(default)]
    ts: Option<String>,
    #[serde(default = "empty_object")]
    props: Value,
}

fn empty_object() -> Value {
    json!({})
}

async fn ingest(Json(payload): Json<IngestRequest>) -> StatusCode {
    if !dev::is_active() {
        return StatusCode::NO_CONTENT;
    }

    let IngestRequest { session, events } = payload;
    dev::record_all(
        events
            .into_iter()
            .take(MAX_EVENTS_PER_REQUEST)
            .map(|incoming| DevEvent {
                source: Source::Frontend,
                event: incoming.event,
                props: incoming.props,
                ts: incoming.ts,
                session: Some(session.clone()),
            }),
    );

    StatusCode::NO_CONTENT
}

/// Record every API call: which endpoint, how it ended, how long it took.
///
/// The request body is deliberately not read. Buffering it here would change
/// the semantics of streaming and multipart endpoints, and the endpoint plus
/// outcome is what makes the log answerable ("which features do I use").
pub(crate) async fn recorder(req: Request, next: Next) -> Response {
    if !dev::is_active() {
        return next.run(req).await;
    }

    let path = request_path(&req);
    if path == HEALTH_PATH || path.ends_with(INGEST_ROUTE) {
        return next.run(req).await;
    }

    let method = req.method().to_string();
    let start = Instant::now();
    let response = next.run(req).await;

    dev::record(DevEvent::backend(
        "rpc",
        json!({
            "method": method,
            "path": path,
            "path_pattern": perf::normalize_path(&path),
            "status": response.status().as_u16(),
            "duration_ms": perf::elapsed_ms(start),
        }),
    ));

    response
}

/// Path as the client sent it. `Router::nest` rewrites the inner request URI,
/// so the un-nested path only appears in the `OriginalUri` extension.
fn request_path(req: &Request) -> String {
    req.extensions().get::<OriginalUri>().map_or_else(
        || req.uri().path().to_string(),
        |uri| uri.0.path().to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;

    #[test]
    fn incoming_events_default_to_empty_properties() {
        let parsed: IncomingEvent = serde_json::from_str(r#"{"event":"ui.click"}"#).unwrap();
        assert_eq!(parsed.props, json!({}));
        assert!(parsed.ts.is_none());
    }

    #[test]
    fn ingest_payload_carries_the_page_session() {
        let parsed: IngestRequest = serde_json::from_str(
            r#"{"session":"page-1","events":[{"event":"ui.key","ts":"2026-08-14T00:00:00.000Z","props":{"combo":"mod+k"}}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.session, "page-1");
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.events[0].props["combo"], "mod+k");
    }

    #[test]
    fn request_path_prefers_the_pre_nesting_uri() {
        let mut req = HttpRequest::builder()
            .uri("/tasks/42")
            .body(Body::empty())
            .unwrap();
        assert_eq!(request_path(&req), "/tasks/42");

        req.extensions_mut()
            .insert(OriginalUri("/rpc/tasks/42".parse().unwrap()));
        assert_eq!(request_path(&req), "/rpc/tasks/42");
    }

    #[test]
    fn the_ingest_route_and_health_are_excluded_from_recording() {
        assert!("/rpc/dev-events".ends_with(INGEST_ROUTE));
        assert!(!"/rpc/tasks".ends_with(INGEST_ROUTE));
        assert_eq!("/health", HEALTH_PATH);
    }
}
