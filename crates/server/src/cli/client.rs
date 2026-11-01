//! The operator API client: one typed call per [`Route`].

use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};
use server_contract::{
    routes::{Route, HEADER_CONTRACT_REV, HEADER_REQUEST_ID},
    Envelope, ErrorBody, ErrorCode, Meta, CONTRACT_REV,
};
use uuid::Uuid;

use super::{
    discovery::{self, Target},
    output::Failure,
};

/// Set by chro for every turn it starts; identifies the calling agent.
const SESSION_TOKEN_ENV: &str = "CHRO_SESSION_TOKEN";
/// Longest a call that starts a turn may take: creating a worktree and
/// spawning an agent can be slow on a cold machine.
const CALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Grace on top of a wait's own timeout before the client gives up.
const WAIT_GRACE: Duration = Duration::from_secs(60);

pub(crate) struct Client {
    target: Target,
    token: String,
    agent: ureq::Agent,
    /// Id of the next mutating call; fixed for the life of one command so a
    /// retried command can reuse it.
    request_id: String,
}

/// A result together with the meta of the server that produced it.
pub(crate) struct Answer<T> {
    pub result: T,
    pub meta: Meta,
}

impl Client {
    pub fn connect(request_id: Option<String>) -> Result<Self, ErrorBody> {
        let target = discovery::locate()?;
        // An agent always acts as itself, even though it could read the
        // owner token from disk: attribution depends on it.
        let token = std::env::var(SESSION_TOKEN_ENV)
            .ok()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .or_else(|| target.owner_token().map(str::to_string))
            .ok_or_else(|| {
                ErrorBody::new(
                    ErrorCode::Unauthorized,
                    "no token for this server; set CHRO_API_TOKEN",
                )
            })?;
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .build();
        Ok(Self {
            target,
            token,
            agent,
            request_id: request_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
        })
    }

    pub fn call<Req: Serialize, Res: DeserializeOwned>(
        &self,
        route: &Route<Req, Res>,
        params: &[&str],
        query: &[(&str, String)],
        body: Option<&Req>,
    ) -> Result<Answer<Res>, Failure> {
        self.call_with_timeout(route, params, query, body, CALL_TIMEOUT)
    }

    /// For long waits: the server answers within `wait`, so allow that plus a
    /// grace period before treating the server as unreachable.
    pub fn call_waiting<Req: Serialize, Res: DeserializeOwned>(
        &self,
        route: &Route<Req, Res>,
        params: &[&str],
        query: &[(&str, String)],
        wait: Duration,
    ) -> Result<Answer<Res>, Failure> {
        self.call_with_timeout(route, params, query, None, wait + WAIT_GRACE)
    }

    fn call_with_timeout<Req: Serialize, Res: DeserializeOwned>(
        &self,
        route: &Route<Req, Res>,
        params: &[&str],
        query: &[(&str, String)],
        body: Option<&Req>,
        timeout: Duration,
    ) -> Result<Answer<Res>, Failure> {
        let url = format!("{}{}", self.target.base_url(), route.path(params));
        let mut request = self
            .agent
            .request(route.method.as_str(), &url)
            .timeout(timeout)
            .set("Authorization", &format!("Bearer {}", self.token))
            .set(HEADER_CONTRACT_REV, CONTRACT_REV);
        for (key, value) in query {
            request = request.query(key, value);
        }
        if route.is_mutating() {
            request = request.set(HEADER_REQUEST_ID, &self.request_id);
        }

        let response = match body {
            Some(body) => request.send_json(body),
            None if route.is_mutating() => request.send_json(serde_json::json!({})),
            None => request.call(),
        };
        let text = match response {
            Ok(response) => response.into_string(),
            Err(ureq::Error::Status(_, response)) => response.into_string(),
            Err(ureq::Error::Transport(err)) => {
                return Err(self.unreachable(route.is_mutating(), err.to_string()).into())
            }
        }
        .map_err(|err| Failure::from(self.unreachable(route.is_mutating(), err.to_string())))?;

        let envelope: Envelope<Res> = Envelope::parse(&text).map_err(|_| {
            Failure::from(ErrorBody::new(
                ErrorCode::ContractMismatch,
                format!(
                    "{} did not answer with the operator API; it may be an older chro",
                    self.target.base_url()
                ),
            ))
        })?;
        let meta = envelope.meta.clone();
        let result = envelope.into_result().map_err(|error| Failure {
            error,
            meta: meta.clone(),
        })?;
        if meta.contract_rev != CONTRACT_REV {
            return Err(ErrorBody::new(
                ErrorCode::ContractMismatch,
                format!(
                    "server speaks contract {} but this CLI speaks {CONTRACT_REV}",
                    meta.contract_rev
                ),
            )
            .into());
        }
        Ok(Answer { result, meta })
    }

    fn unreachable(&self, mutating: bool, detail: String) -> ErrorBody {
        let mut error = ErrorBody::new(
            ErrorCode::Unreachable,
            format!("no answer from {}: {detail}", self.target.base_url()),
        );
        if mutating {
            // The call may have taken effect. Retrying with the same id
            // returns its answer instead of acting a second time.
            error = error.with_next(retry_command(&self.request_id));
        }
        error
    }
}

/// The current command line with `--request-id` pinned to `id`.
fn retry_command(id: &str) -> String {
    let mut args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|arg| arg == "--request-id") {
        args.drain(pos..(pos + 2).min(args.len()));
    }
    args.retain(|arg| !arg.starts_with("--request-id="));
    args.insert(1.min(args.len()), format!("--request-id={id}"));
    args.iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn shell_quote(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c))
    {
        arg.to_string()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_leaves_plain_words_alone_and_wraps_the_rest() {
        assert_eq!(shell_quote("session"), "session");
        assert_eq!(shell_quote("--request-id=ab-1"), "--request-id=ab-1");
        assert_eq!(shell_quote("fix the bug"), "'fix the bug'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
    }
}
