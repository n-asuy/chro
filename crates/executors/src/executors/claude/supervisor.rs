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
    transcript::{TranscriptTailer, map_transcript_line},
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
                        self.pump_transcript(tailer).await;
                    }
                    if stop.is_some() {
                        break RunOutcome::Completed;
                    }
                    break RunOutcome::DiedMidTurn(exit);
                }

                _ = poll.tick() => {
                    let mut wrote = false;
                    if let Some(tailer) = tailer.as_mut() {
                        wrote = self.pump_transcript(tailer).await;
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
                self.sink
                    .write_json(&json!({
                        "type": "result",
                        "subtype": "success",
                        "is_error": false,
                        "duration_ms": started.elapsed().as_millis() as u64,
                        "session_id": session_id,
                        "result": last_assistant_message,
                    }))
                    .await;
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
    async fn pump_transcript(&self, tailer: &mut TranscriptTailer) -> bool {
        let mut wrote = false;
        for raw in tailer.read_new_lines().await {
            if let Some(mapped) = map_transcript_line(&raw) {
                wrote = true;
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

async fn wait_for_exit(
    rx: &mut watch::Receiver<Option<ProcessExit>>,
) -> Option<ProcessExit> {
    loop {
        if let Some(exit) = rx.borrow_and_update().clone() {
            return Some(exit);
        }
        if rx.changed().await.is_err() {
            return None;
        }
    }
}
