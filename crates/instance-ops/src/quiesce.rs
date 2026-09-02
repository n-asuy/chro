//! Holding the machine still so it can be stopped or captured safely.
//!
//! A stop that lands mid-write loses whatever the agent was in the middle of
//! doing. Quiescing asks the server to finish what it has, stop taking new
//! work, and flush, and only then reports that the machine is safe to stop.

use serde::{Deserialize, Serialize};

use crate::Quiesced;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuiesceOutcome {
    /// Nothing is running and writes have settled.
    Settled,
    /// Work is still finishing. The caller should ask again rather than stop
    /// the machine now.
    Busy { running_runs: u32 },
    /// The server could not be reached, so nothing could be settled. Stopping
    /// now risks losing whatever it was doing.
    ServerUnreachable,
}

impl QuiesceOutcome {
    /// Whether the machine can be stopped without losing work.
    pub fn safe_to_stop(&self) -> bool {
        matches!(self, Self::Settled)
    }
}

pub struct QuiesceRequest {
    base_url: String,
    client: reqwest::Client,
}

impl QuiesceRequest {
    pub fn new(base_url: String) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Asks the server to stop taking work and flush what it has.
    pub async fn run(&self, quiesced: &Quiesced) -> QuiesceOutcome {
        #[derive(Deserialize, Default)]
        struct Settle {
            #[serde(default)]
            running_runs: u32,
        }

        // Set first: from this moment the machine reports itself as held, even
        // if the call below fails. A stop that is refused is recoverable; one
        // that proceeds while the server is still writing is not.
        quiesced.set(true);

        let response = self
            .client
            .post(format!("{}/rpc/quiesce", self.base_url))
            .send()
            .await;

        match response {
            Ok(response) if response.status().is_success() => {
                let settle: Settle = response.json().await.unwrap_or_default();
                if settle.running_runs == 0 {
                    QuiesceOutcome::Settled
                } else {
                    QuiesceOutcome::Busy {
                        running_runs: settle.running_runs,
                    }
                }
            }
            // A server that cannot be asked has not been settled. Saying so is
            // what lets the caller choose to wait rather than lose work.
            _ => QuiesceOutcome::ServerUnreachable,
        }
    }

    /// Lets the machine take work again after a stop was abandoned.
    pub async fn resume(&self, quiesced: &Quiesced) {
        quiesced.set(false);
        let _ = self
            .client
            .post(format!("{}/rpc/resume", self.base_url))
            .send()
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_settled_machine_is_safe_to_stop() {
        assert!(QuiesceOutcome::Settled.safe_to_stop());
        assert!(!QuiesceOutcome::Busy { running_runs: 1 }.safe_to_stop());
        // An unreachable server has not settled anything, so stopping would
        // risk losing work in flight.
        assert!(!QuiesceOutcome::ServerUnreachable.safe_to_stop());
    }

    #[tokio::test]
    async fn the_machine_reports_itself_held_even_when_the_call_fails() {
        let request = QuiesceRequest::new("http://127.0.0.1:1".into());
        let quiesced = Quiesced::new();

        let outcome = request.run(&quiesced).await;

        assert_eq!(outcome, QuiesceOutcome::ServerUnreachable);
        // The flag stays set: a refused stop is recoverable, a stop that races
        // an unresponsive server is not.
        assert!(quiesced.is_set());
    }

    #[tokio::test]
    async fn resuming_clears_the_hold() {
        let request = QuiesceRequest::new("http://127.0.0.1:1".into());
        let quiesced = Quiesced::new();
        quiesced.set(true);

        request.resume(&quiesced).await;

        assert!(!quiesced.is_set());
    }
}
