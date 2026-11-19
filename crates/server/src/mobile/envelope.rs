//! The RPC envelope inside encrypted text frames.
//!
//! Requests: `{"id", "deviceToken", "method", "params"}`.
//! Replies: `{"id", "ok": true, "result", "_meta"}` or
//! `{"id", "ok": false, "error": {"code", "message", "data"}, "_meta"}`, with
//! `"streaming": true` on every reply of a subscription.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One request from a device.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RpcRequest {
    pub id: String,
    pub device_token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Wire error codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ErrorCode {
    /// The frame is not a request envelope.
    BadRequest,
    /// The envelope's device token is not the connection's.
    Unauthorized,
    MethodNotFound,
    InvalidArgument,
    /// The endpoint is not on the device allowlist.
    Forbidden,
    /// No such route or stream.
    NotFound,
    /// The device speaks another API generation, or has not declared one.
    IncompatibleApi,
    ReplyTooLarge,
    /// Too many requests, subscriptions or uploads in flight, on this
    /// connection or on the server.
    RuntimeBusy,
    /// A request did not answer within the request deadline.
    DeadlineExceeded,
    Internal,
}

impl ErrorCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::Unauthorized => "unauthorized",
            ErrorCode::MethodNotFound => "method_not_found",
            ErrorCode::InvalidArgument => "invalid_argument",
            ErrorCode::Forbidden => "forbidden",
            ErrorCode::NotFound => "not_found",
            ErrorCode::IncompatibleApi => "incompatible_api",
            ErrorCode::ReplyTooLarge => "reply_too_large",
            ErrorCode::RuntimeBusy => "runtime_busy",
            ErrorCode::DeadlineExceeded => "deadline_exceeded",
            ErrorCode::Internal => "internal",
        }
    }
}

/// An error reply's body. `code` is a string so registry errors (ticket
/// exchange) pass through with their own codes.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct RpcError {
    pub code: &'static str,
    pub message: String,
    pub data: Value,
}

impl RpcError {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self::coded(code.as_str(), message)
    }

    pub(crate) fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: Value::Null,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplyMeta {
    pub runtime_id: Option<String>,
}

/// One reply to a device.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct RpcReply {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
    #[serde(rename = "_meta")]
    pub meta: ReplyMeta,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub streaming: bool,
}

/// The id replies use when the request could not be parsed far enough to
/// have one.
pub(crate) const UNKNOWN_ID: &str = "unknown";

impl RpcReply {
    pub(crate) fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
            meta: meta(),
            streaming: false,
        }
    }

    pub(crate) fn streamed(id: impl Into<String>, result: Value) -> Self {
        Self {
            streaming: true,
            ..Self::success(id, result)
        }
    }

    pub(crate) fn failure(id: impl Into<String>, error: RpcError) -> Self {
        Self {
            id: id.into(),
            ok: false,
            result: None,
            error: Some(error),
            meta: meta(),
            streaming: false,
        }
    }

    pub(crate) fn to_json(&self) -> String {
        serde_json::to_string(self).expect("replies always serialize")
    }
}

fn meta() -> ReplyMeta {
    ReplyMeta {
        runtime_id: crate::operator::meta().runtime_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_parse_in_any_key_order_and_default_params() {
        let request: RpcRequest = serde_json::from_value(json!({
            "method": "status.get",
            "deviceToken": "t",
            "id": "rpc-1-1",
        }))
        .unwrap();
        assert_eq!(request.id, "rpc-1-1");
        assert_eq!(request.params, Value::Null);
    }

    #[test]
    fn unknown_envelope_keys_are_refused() {
        let parsed = serde_json::from_value::<RpcRequest>(json!({
            "id": "1", "deviceToken": "t", "method": "m", "params": {}, "extra": 1,
        }));
        assert!(parsed.is_err());
    }

    #[test]
    fn replies_use_the_wire_field_names() {
        let ok = serde_json::to_value(RpcReply::success("1", json!({"a": 1}))).unwrap();
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["result"], json!({"a": 1}));
        assert!(ok.get("error").is_none());
        assert!(ok.get("streaming").is_none());
        assert!(ok["_meta"].as_object().unwrap().contains_key("runtimeId"));

        let streamed = serde_json::to_value(RpcReply::streamed("1", json!({}))).unwrap();
        assert_eq!(streamed["streaming"], true);

        let failed = serde_json::to_value(RpcReply::failure(
            "1",
            RpcError::new(ErrorCode::Forbidden, "no"),
        ))
        .unwrap();
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["error"]["code"], "forbidden");
        assert_eq!(failed["error"]["data"], Value::Null);
        assert!(failed.get("result").is_none());
    }
}
