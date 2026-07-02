//! Lifecycle supervisor for one PTY-hosted Claude run.
//!
//! Drives the run's data plane: hook events discover the transcript, the
//! tailer streams conversation lines into the synthetic stdout, and a final
//! `result` line is synthesized when the turn ends (`Stop` hook) or the
//! child dies — the container completes the run off that line, exactly as it
//! did with `--print` output.

use std::{path::PathBuf, time::Duration};

use serde_json::{Value, json};
use tokio::sync::{mpsc::UnboundedReceiver, watch};
use tokio_util::sync::CancellationToken;

use super::{
    hook_server::{ClaudeHookServer, HookEvent, HookEventKind},
    log_sink::LogLineSink,
    transcript::{TranscriptTailer, api_error_line_text, map_transcript_line},
    types::{
        API_ERROR_MESSAGE, API_ERROR_SUBTYPE, MALFORMED_TOOL_CALL_ABORT_TEXT,
        MALFORMED_TOOL_CALL_MESSAGE, MALFORMED_TOOL_CALL_SUBTYPE,
    },
};
use crate::process::ProcessExit;

/// How often the transcript file is polled for new lines.
const TAIL_POLL_INTERVAL: Duration = Duration::from_millis(120);
/// Stop is posted by Claude before the final transcript lines are guaranteed
/// to be on disk; keep draining until the file is quiet for this many polls.
const QUIESCENT_POLLS_AFTER_STOP: u32 = 6;
/// Hard cap on the post-Stop drain.
const MAX_DRAIN_AFTER_STOP: Duration = Duration::from_secs(5);
/// A healthy run posts UserPromptSubmit within seconds of launch; if no hook
/// arrives at all, the hook wiring is broken and the run must fail instead of
/// hanging forever.
const FIRST_HOOK_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) struct RunSupervisor {
    pub events: UnboundedReceiver<HookEvent>,
    pub sink: LogLineSink,
    pub cancel: CancellationToken,
    pub is_resume: bool,
    pub settings_path: PathBuf,
    pub server: ClaudeHookServer,
    pub child_exit: watch::Receiver<Option<ProcessExit>>,
}

impl RunSupervisor {
    pub fn spawn(self) {
        tokio::spawn(self.run());
    }

    async fn run(mut self) {
        let started = std::time::Instant::now();
        let mut tailer: Option<TranscriptTailer> = None;
        let mut session_id: Option<String> = None;
        let mut last_assistant_message: Option<String> = None;
        // Last assistant text observed in the transcript itself, used as a
        // fallback signal for malformed-tool-call detection (the `Stop` hook's
        // `last_assistant_message` is not guaranteed to carry the CLI's
        // turn-ending failure text).
        let mut last_assistant_text: Option<String> = None;
        // Set to the CLI's API-error text (rate limit, usage limit, ...) when the
        // turn's last assistant line is one; cleared by any subsequent real
        // assistant output. Drives the api-error abort outcome below.
        let mut last_api_error: Option<String> = None;
        let mut stop: Option<StopDrain> = None;
        let mut poll = tokio::time::interval(TAIL_POLL_INTERVAL);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let first_hook_deadline = tokio::time::Instant::now() + FIRST_HOOK_TIMEOUT;

        let outcome = loop {
            tokio::select! {
                biased;

                // Container-initiated cancellation: wind down silently, the
                // run status is already decided on the container side.
                _ = self.cancel.cancelled() => break RunOutcome::Cancelled,

                event = self.events.recv() => {
                    let Some(event) = event else { break RunOutcome::HooksLost };
                    if tailer.is_none()
                        && let Some(path) = event.transcript_path.as_deref()
                    {
                        tailer = Some(TranscriptTailer::new(path, self.is_resume).await);
                    }
                    if session_id.is_none() {
                        session_id = event.session_id.clone();
                    }
                    match event.kind {
                        HookEventKind::Stop => {
                            last_assistant_message = event
                                .payload
                                .get("last_assistant_message")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                            stop.get_or_insert(StopDrain::new());
                        }
                        HookEventKind::Notification => {
                            let message = event
                                .payload
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            tracing::debug!(%message, "claude notification hook");
                        }
                        HookEventKind::UserPromptSubmit | HookEventKind::Other => {}
                    }
                }

                exit = wait_for_exit(&mut self.child_exit) => {
                    // Flush whatever the transcript already holds, then decide.
                    if let Some(tailer) = tailer.as_mut() {
                        self.pump_transcript(tailer, &mut last_assistant_text, &mut last_api_error)
                            .await;
                    }
                    if stop.is_some() {
                        break RunOutcome::Completed;
                    }
                    break RunOutcome::DiedMidTurn(exit);
                }

                _ = poll.tick() => {
                    let mut wrote = false;
                    if let Some(tailer) = tailer.as_mut() {
                        wrote = self
                            .pump_transcript(tailer, &mut last_assistant_text, &mut last_api_error)
                            .await;
                    }
                    if let Some(drain) = stop.as_mut() {
                        if drain.settled(wrote) {
                            break RunOutcome::Completed;
                        }
                    } else if tailer.is_none()
                        && tokio::time::Instant::now() >= first_hook_deadline
                    {
                        break RunOutcome::HooksLost;
                    }
                }
            }
        };

        match outcome {
            RunOutcome::Completed => {
                // A turn that ends on the CLI's malformed-tool-call failure text
                // ran no tool and produced no work; surface it as a recoverable
                // error (marks the run failed, offers a retry) instead of a
                // silent success. The Stop payload and the transcript tail are
                // both checked because either may carry the failure text.
                let aborted_on_malformed_tool_call = [
                    last_assistant_message.as_deref(),
                    last_assistant_text.as_deref(),
                ]
                .into_iter()
                .flatten()
                .any(|text| text.contains(MALFORMED_TOOL_CALL_ABORT_TEXT));

                let result = if aborted_on_malformed_tool_call {
                    json!({
                        "type": "result",
                        "subtype": MALFORMED_TOOL_CALL_SUBTYPE,
                        "is_error": true,
                        "error": MALFORMED_TOOL_CALL_MESSAGE,
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "session_id": session_id,
                        "result": MALFORMED_TOOL_CALL_MESSAGE,
                    })
                } else if let Some(api_error) = last_api_error.as_deref() {
                    // The turn ended on a server-side API error (rate limit,
                    // usage limit, ...) and did no work; surface it as a
                    // recoverable error carrying the CLI's own text so the run is
                    // marked failed with a retry instead of a silent success.
                    let message = if api_error.is_empty() {
                        API_ERROR_MESSAGE
                    } else {
                        api_error
                    };
                    json!({
                        "type": "result",
                        "subtype": API_ERROR_SUBTYPE,
                        "is_error": true,
                        "error": message,
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "session_id": session_id,
                        "result": message,
                    })
                } else {
                    json!({
                        "type": "result",
                        "subtype": "success",
                        "is_error": false,
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "session_id": session_id,
                        "result": last_assistant_message,
                    })
                };
                self.sink.write_json(&result).await;
            }
            RunOutcome::DiedMidTurn(exit) => {
                let code = exit.as_ref().and_then(|e| e.code);
                self.sink
                    .write_json(&json!({
                        "type": "result",
                        "subtype": "error_during_execution",
                        "is_error": true,
                        "error": format!(
                            "Claude exited before completing the turn (exit code: {})",
                            code.map_or_else(|| "unknown".to_string(), |c| c.to_string())
                        ),
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "session_id": session_id,
                    }))
                    .await;
            }
            RunOutcome::HooksLost => {
                self.sink
                    .write_json(&json!({
                        "type": "result",
                        "subtype": "error_during_execution",
                        "is_error": true,
                        "error": "No hook events received from Claude; hook wiring is broken or the CLI failed to start",
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "session_id": session_id,
                    }))
                    .await;
            }
            RunOutcome::Cancelled => {}
        }

        self.sink.close().await;
        self.server.shutdown();
        let _ = tokio::fs::remove_file(&self.settings_path).await;
    }

    /// Move new transcript lines into the synthetic stdout. Returns whether
    /// any line was written (drives the post-Stop quiescence check).
    ///
    /// Records the most recent assistant text block in `last_assistant_text` so
    /// the turn outcome can detect a malformed-tool-call abort even when the
    /// `Stop` hook payload omits the CLI's turn-ending failure message, and
    /// captures any CLI API-error line in `last_api_error` so a rate-/usage-limit
    /// turn fails with a retry instead of completing silently.
    async fn pump_transcript(
        &self,
        tailer: &mut TranscriptTailer,
        last_assistant_text: &mut Option<String>,
        last_api_error: &mut Option<String>,
    ) -> bool {
        let mut wrote = false;
        for raw in tailer.read_new_lines().await {
            // A CLI API-error line (rate limit, usage limit, ...) ends the turn
            // and is not model output: capture its text for the run outcome and
            // keep it out of the conversation stream (map_transcript_line also
            // drops it). It still counts as activity so the post-Stop drain does
            // not settle before it is read.
            if let Some(text) = api_error_line_text(&raw) {
                *last_api_error = Some(text);
                wrote = true;
                continue;
            }
            if let Some(mapped) = map_transcript_line(&raw) {
                wrote = true;
                if let Some(text) = assistant_text(&mapped) {
                    *last_assistant_text = Some(text);
                    // Real model output supersedes any earlier transient error.
                    *last_api_error = None;
                }
                if !self.sink.write_line(&mapped).await {
                    break;
                }
            }
        }
        wrote
    }
}

enum RunOutcome {
    Completed,
    DiedMidTurn(Option<ProcessExit>),
    HooksLost,
    Cancelled,
}

struct StopDrain {
    deadline: tokio::time::Instant,
    quiet_polls: u32,
}

impl StopDrain {
    fn new() -> Self {
        Self {
            deadline: tokio::time::Instant::now() + MAX_DRAIN_AFTER_STOP,
            quiet_polls: 0,
        }
    }

    fn settled(&mut self, wrote_this_poll: bool) -> bool {
        if wrote_this_poll {
            self.quiet_polls = 0;
        } else {
            self.quiet_polls += 1;
        }
        self.quiet_polls >= QUIESCENT_POLLS_AFTER_STOP
            || tokio::time::Instant::now() >= self.deadline
    }
}

/// Concatenated text of a mapped assistant stream-json line, or `None` when the
/// line is not an assistant message or carries no text blocks (thinking-only or
/// tool_use turns). Tracks the turn's final assistant text for abort detection.
fn assistant_text(mapped: &str) -> Option<String> {
    let value: Value = serde_json::from_str(mapped).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let blocks = value.get("message")?.get("content")?.as_array()?;
    let mut text = String::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) == Some("text")
            && let Some(chunk) = block.get("text").and_then(Value::as_str)
        {
            text.push_str(chunk);
        }
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn wait_for_exit(rx: &mut watch::Receiver<Option<ProcessExit>>) -> Option<ProcessExit> {
    loop {
        if let Some(exit) = rx.borrow_and_update().clone() {
            return Some(exit);
        }
        if rx.changed().await.is_err() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_text_concatenates_text_blocks() {
        let mapped = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"hello "},{"type":"text","text":"world"}]}}"#;
        assert_eq!(assistant_text(mapped).as_deref(), Some("hello world"));
    }

    #[test]
    fn assistant_text_skips_non_assistant_and_textless_lines() {
        let user =
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(assistant_text(user), None);

        let tool_only = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#;
        assert_eq!(assistant_text(tool_only), None);

        assert_eq!(assistant_text("not json"), None);
    }

    #[test]
    fn malformed_abort_text_matches_cli_turn_ending_sentinel() {
        // The exact assistant line the CLI writes when its own reparse fails.
        let sentinel = "The model's tool call could not be parsed (retry also failed).";
        assert!(sentinel.contains(MALFORMED_TOOL_CALL_ABORT_TEXT));
        assert!(!"All tests pass.".contains(MALFORMED_TOOL_CALL_ABORT_TEXT));
    }
}
