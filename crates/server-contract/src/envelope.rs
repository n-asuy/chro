//! The single response shape of every operator API call and every `--json`
//! CLI output: `{ "ok": true, "result": .., "meta": .. }` on success and
//! `{ "ok": false, "error": .., "meta": .. }` on failure.

use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::error::ErrorBody;

/// Which server produced a response, and from which contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    /// `None` when the failure happened before any server answered.
    pub runtime_id: Option<String>,
    pub contract_rev: String,
}

impl Meta {
    /// Meta of a failure the CLI produced without reaching a server.
    pub fn local() -> Self {
        Self {
            runtime_id: None,
            contract_rev: crate::CONTRACT_REV.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub ok: bool,
    // Missing members read as `None` without `default`, which would also
    // demand `T: Default`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
    pub meta: Meta,
}

impl<T> Envelope<T> {
    pub fn success(result: T, meta: Meta) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
            meta,
        }
    }

    pub fn failure(error: ErrorBody, meta: Meta) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(error),
            meta,
        }
    }

    pub fn into_result(self) -> Result<T, ErrorBody> {
        match (self.ok, self.result, self.error) {
            (true, Some(result), _) => Ok(result),
            (false, _, Some(error)) => Err(error),
            _ => Err(ErrorBody::new(
                crate::ErrorCode::Internal,
                "response is neither a result nor an error",
            )),
        }
    }
}

impl<T: DeserializeOwned> Envelope<T> {
    /// Parse a response body. Leading whitespace is accepted because long
    /// waits keep their connection alive with blank lines before the answer.
    pub fn parse(body: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(body.trim_start())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorCode;
    use serde_json::json;

    fn meta() -> Meta {
        Meta {
            runtime_id: Some("rt-1".into()),
            contract_rev: "0.1.0+00000000".into(),
        }
    }

    #[test]
    fn success_has_result_and_no_error_member() {
        let value = serde_json::to_value(Envelope::success(json!({ "n": 1 }), meta())).unwrap();
        assert_eq!(
            value,
            json!({
                "ok": true,
                "result": { "n": 1 },
                "meta": { "runtime_id": "rt-1", "contract_rev": "0.1.0+00000000" }
            })
        );
    }

    #[test]
    fn failure_has_error_and_no_result_member() {
        let envelope: Envelope<()> =
            Envelope::failure(ErrorBody::new(ErrorCode::Timeout, "still running"), meta());
        let value = serde_json::to_value(envelope).unwrap();
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["error"]["code"], json!("timeout"));
        assert!(value.get("result").is_none());
    }

    #[test]
    fn parse_tolerates_keepalive_padding() {
        let body = "\n\n\n{\"ok\":true,\"result\":5,\"meta\":{\"runtime_id\":null,\"contract_rev\":\"x\"}}";
        let envelope: Envelope<u32> = Envelope::parse(body).unwrap();
        assert_eq!(envelope.into_result().unwrap(), 5);
    }

    #[test]
    fn into_result_surfaces_the_error() {
        let envelope: Envelope<u32> =
            Envelope::failure(ErrorBody::new(ErrorCode::NotFound, "gone"), meta());
        assert_eq!(envelope.into_result().unwrap_err().code, ErrorCode::NotFound);
    }
}
