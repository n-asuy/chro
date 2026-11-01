//! Request ids make mutating calls safe to retry.
//!
//! A CLI whose response was lost cannot tell whether its `send` started a
//! turn. It re-sends with the same request id, and the server answers with the
//! first response instead of acting twice. Records live in memory for a day: a
//! retry is meaningful within seconds, and a server restart already ends every
//! turn the original request could have started.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use server_contract::{routes::HEADER_REQUEST_ID, ErrorCode};

use super::{Caller, V1Error};
use crate::AppState;

const RETENTION: Duration = Duration::from_secs(24 * 60 * 60);
/// Responses above this are not worth replaying; operator results are small.
const MAX_RECORDED_BODY: usize = 4 * 1024 * 1024;

enum Record {
    InFlight,
    Done {
        at: Instant,
        status: StatusCode,
        body: Bytes,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum Begin {
    /// First time this id is seen: run the request.
    Fresh,
    /// The first request with this id has not answered yet.
    InFlight,
    /// Answer with the recorded response.
    Replay(StatusCode, Bytes),
}

#[derive(Default)]
pub(crate) struct IdempotencyLedger {
    records: Mutex<HashMap<String, Record>>,
}

impl IdempotencyLedger {
    fn begin(&self, key: &str, now: Instant) -> Begin {
        let mut records = self.records.lock().expect("idempotency ledger");
        records.retain(|_, record| match record {
            Record::InFlight => true,
            Record::Done { at, .. } => now.duration_since(*at) < RETENTION,
        });
        match records.get(key) {
            Some(Record::InFlight) => Begin::InFlight,
            Some(Record::Done { status, body, .. }) => Begin::Replay(*status, body.clone()),
            None => {
                records.insert(key.to_string(), Record::InFlight);
                Begin::Fresh
            }
        }
    }

    fn finish(&self, key: &str, status: StatusCode, body: Bytes, now: Instant) {
        self.records.lock().expect("idempotency ledger").insert(
            key.to_string(),
            Record::Done {
                at: now,
                status,
                body,
            },
        );
    }

    /// Forget an id whose request failed in a way a retry may fix.
    fn abandon(&self, key: &str) {
        self.records.lock().expect("idempotency ledger").remove(key);
    }
}

pub(crate) async fn deduplicate(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let Some(request_id) = request
        .headers()
        .get(HEADER_REQUEST_ID)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return next.run(request).await;
    };
    let caller = request
        .extensions()
        .get::<Caller>()
        .map(Caller::key)
        .unwrap_or_default();
    let key = format!(
        "{caller} {} {} {request_id}",
        request.method(),
        request.uri().path()
    );

    let ledger = state.idempotency();
    match ledger.begin(&key, Instant::now()) {
        Begin::Replay(status, body) => return replay(status, body),
        Begin::InFlight => {
            return V1Error::new(
                ErrorCode::RequestInProgress,
                format!("request {request_id} is still running; retry it once it answers"),
            )
            .into_response()
        }
        Begin::Fresh => {}
    }

    let response = next.run(request).await;
    let status = response.status();
    if status.is_server_error() {
        ledger.abandon(&key);
        return response;
    }
    let (parts, body) = response.into_parts();
    match to_bytes(body, MAX_RECORDED_BODY).await {
        Ok(bytes) => {
            ledger.finish(&key, status, bytes.clone(), Instant::now());
            Response::from_parts(parts, Body::from(bytes))
        }
        Err(err) => {
            ledger.abandon(&key);
            V1Error::new(
                ErrorCode::Internal,
                format!("response too large to record: {err}"),
            )
            .into_response()
        }
    }
}

fn replay(status: StatusCode, body: Bytes) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/json"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repeated_id_replays_the_first_response() {
        let ledger = IdempotencyLedger::default();
        let now = Instant::now();
        assert_eq!(ledger.begin("k", now), Begin::Fresh);
        ledger.finish("k", StatusCode::OK, Bytes::from_static(b"{}"), now);
        assert_eq!(
            ledger.begin("k", now),
            Begin::Replay(StatusCode::OK, Bytes::from_static(b"{}"))
        );
    }

    #[test]
    fn a_concurrent_repeat_is_told_to_wait() {
        let ledger = IdempotencyLedger::default();
        let now = Instant::now();
        assert_eq!(ledger.begin("k", now), Begin::Fresh);
        assert_eq!(ledger.begin("k", now), Begin::InFlight);
    }

    #[test]
    fn an_abandoned_id_can_run_again() {
        let ledger = IdempotencyLedger::default();
        let now = Instant::now();
        ledger.begin("k", now);
        ledger.abandon("k");
        assert_eq!(ledger.begin("k", now), Begin::Fresh);
    }

    #[test]
    fn records_expire_after_a_day() {
        let ledger = IdempotencyLedger::default();
        let then = Instant::now();
        ledger.begin("k", then);
        ledger.finish("k", StatusCode::OK, Bytes::new(), then);
        let later = then + RETENTION + Duration::from_secs(1);
        assert_eq!(ledger.begin("k", later), Begin::Fresh);
    }
}
