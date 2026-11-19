//! The stdio control channel of a headless Claude turn.
//!
//! Claude runs with `--input-format stream-json --permission-prompt-tool stdio`:
//! the prompt goes in as one stream-json user message, and the CLI asks its
//! caller before using a tool by writing a `control_request` to stdout and
//! waiting for the matching `control_response` on stdin. That channel is what
//! makes `AskUserQuestion` available at all; without it the tool is dropped
//! from a `--print` run.
//!
//! [`ControlChannel`] owns both pipes for one turn. Every stdout line except
//! control traffic is mirrored into the synthetic log stream the container
//! reads, so log normalization is unchanged. `AskUserQuestion` becomes a chro
//! question approval and its answers go back in `updatedInput.answers`; every
//! other tool is allowed as is (permissions are already bypassed). Stdin is
//! closed once the turn's `result` line arrives, which ends the process.

use std::sync::Arc;

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    sync::Mutex,
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;

use super::QUESTION_TOOL;
use crate::{
    approvals::{ExecutorApprovalError, ExecutorApprovalService, QuestionStatus},
    stdout_dup::LogWriter,
};

const NO_QUESTION_CHANNEL: &str =
    "Questions cannot be shown in this run. Ask the user in plain text instead.";
/// Worded exactly as the desktop's `QUESTIONS_SKIPPED_MESSAGE`, which the
/// history card matches to show "Skipped".
const QUESTIONS_SKIPPED: &str = "User skipped questions - proceed with defaults";
/// Worded exactly as the desktop's `QUESTIONS_TIMED_OUT_MESSAGE`.
const QUESTIONS_TIMED_OUT: &str = "Timed out";
const QUESTIONS_CANCELLED: &str = "The questions were cancelled before an answer arrived.";

/// The stream-json user message that carries the turn's prompt.
pub(crate) fn user_message_line(prompt: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": prompt },
    })
    .to_string()
}

/// What one stdout line means to the control channel.
#[derive(Debug, PartialEq)]
enum Line {
    /// The CLI asks for a decision and waits for the response.
    ControlRequest { request_id: String, request: Value },
    /// Control bookkeeping with no log meaning (cancellations, responses).
    ControlOther,
    /// The turn's final `result` line; logged, then stdin closes.
    TurnResult,
    /// Anything else, logged as is.
    Log,
}

fn classify(line: &str) -> Line {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Line::Log;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("control_request") => match value.get("request_id").and_then(Value::as_str) {
            Some(request_id) => Line::ControlRequest {
                request_id: request_id.to_string(),
                request: value.get("request").cloned().unwrap_or(Value::Null),
            },
            None => Line::ControlOther,
        },
        Some("control_response" | "control_cancel_request") => Line::ControlOther,
        Some("result") => Line::TurnResult,
        _ => Line::Log,
    }
}

fn success(request_id: &str, response: Value) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    })
}

fn failure(request_id: &str, error: &str) -> Value {
    json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error },
    })
}

fn allow(input: Value) -> Value {
    json!({ "behavior": "allow", "updatedInput": input })
}

fn deny(message: &str) -> Value {
    json!({ "behavior": "deny", "message": message })
}

/// The permission decision for an answered (or unanswered) question set.
fn question_decision(
    input: Value,
    outcome: Result<QuestionStatus, ExecutorApprovalError>,
) -> Value {
    match outcome {
        Ok(QuestionStatus::Answered { answers }) => {
            let mut input = input;
            if let Some(fields) = input.as_object_mut() {
                fields.insert("answers".to_string(), json!(answers));
            }
            allow(input)
        }
        Ok(QuestionStatus::Resolved { approved: true }) => allow(input),
        Ok(QuestionStatus::Resolved { approved: false }) => deny(QUESTIONS_SKIPPED),
        Ok(QuestionStatus::TimedOut) => deny(QUESTIONS_TIMED_OUT),
        Err(ExecutorApprovalError::Cancelled) => deny(QUESTIONS_CANCELLED),
        Err(err) => {
            tracing::warn!("claude question approval failed: {err}");
            deny(NO_QUESTION_CHANNEL)
        }
    }
}

type Stdin = Box<dyn AsyncWrite + Send + Unpin>;

pub(crate) struct ControlChannel {
    /// `None` once closed; responses after that are dropped.
    stdin: Mutex<Option<Stdin>>,
    log: LogWriter,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
    cancel: CancellationToken,
}

impl ControlChannel {
    /// Send the prompt and serve the turn until the CLI's stdout ends.
    pub(crate) fn start(
        stdin: impl AsyncWrite + Send + Unpin + 'static,
        stdout: impl AsyncRead + Send + Unpin + 'static,
        log: LogWriter,
        approvals: Option<Arc<dyn ExecutorApprovalService>>,
        cancel: CancellationToken,
        prompt: &str,
    ) -> JoinHandle<()> {
        let channel = Arc::new(Self {
            stdin: Mutex::new(Some(Box::new(stdin))),
            log,
            approvals,
            // A child token: the run's cancellation reaches question waits,
            // while the channel ending its own waits leaves the run alone.
            cancel: cancel.child_token(),
        });
        let prompt = user_message_line(prompt);
        tokio::spawn(async move {
            channel.write_line(&prompt).await;
            channel.serve(stdout).await;
        })
    }

    async fn serve(self: Arc<Self>, stdout: impl AsyncRead + Unpin) {
        let mut lines = BufReader::new(stdout).lines();
        let mut pending = Vec::new();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    match classify(&line) {
                        Line::ControlRequest {
                            request_id,
                            request,
                        } => {
                            // Answered off the reader so a question waiting on
                            // the user never stops the log stream.
                            let channel = self.clone();
                            pending.push(tokio::spawn(async move {
                                let response = channel.decide(&request_id, request).await;
                                channel.write_line(&response.to_string()).await;
                            }));
                        }
                        Line::ControlOther => {}
                        Line::TurnResult => {
                            self.mirror(&line).await;
                            self.close_stdin().await;
                        }
                        Line::Log => self.mirror(&line).await,
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    tracing::warn!("error reading claude stdout: {err}");
                    break;
                }
            }
        }
        // The process is gone: unblock any question still waiting on the user.
        self.cancel.cancel();
        for task in pending {
            let _ = task.await;
        }
        self.close_stdin().await;
    }

    async fn decide(&self, request_id: &str, request: Value) -> Value {
        if request.get("subtype").and_then(Value::as_str) != Some("can_use_tool") {
            return failure(request_id, "unsupported control request");
        }
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        if request.get("tool_name").and_then(Value::as_str) != Some(QUESTION_TOOL) {
            return success(request_id, allow(input));
        }
        success(request_id, self.ask(input).await)
    }

    async fn ask(&self, input: Value) -> Value {
        let Some(approvals) = &self.approvals else {
            return deny(NO_QUESTION_CHANNEL);
        };
        let outcome = match approvals
            .create_question_approval(QUESTION_TOOL, input.clone())
            .await
        {
            Ok(approval_id) => {
                approvals
                    .wait_question_answer(&approval_id, self.cancel.clone())
                    .await
            }
            Err(err) => Err(err),
        };
        question_decision(input, outcome)
    }

    async fn mirror(&self, line: &str) {
        if let Err(err) = self.log.log_raw(line).await {
            tracing::warn!("failed to mirror claude output: {err}");
        }
    }

    async fn write_line(&self, line: &str) {
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return;
        };
        let written = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        }
        .await;
        if let Err(err) = written {
            tracing::warn!("failed to write to claude stdin: {err}");
        }
    }

    async fn close_stdin(&self) {
        if let Some(mut stdin) = self.stdin.lock().await.take() {
            let _ = stdin.shutdown().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex as StdMutex};

    use approvals::ApprovalStatus;
    use async_trait::async_trait;
    use tokio::io::{AsyncBufReadExt, DuplexStream, duplex};

    use super::*;

    /// Records question approvals and answers them with a fixed outcome.
    struct FakeApprovals {
        outcome: StdMutex<Option<Result<QuestionStatus, ExecutorApprovalError>>>,
        asked: StdMutex<Vec<Value>>,
    }

    impl FakeApprovals {
        fn answering(outcome: Result<QuestionStatus, ExecutorApprovalError>) -> Arc<Self> {
            Arc::new(Self {
                outcome: StdMutex::new(Some(outcome)),
                asked: StdMutex::new(Vec::new()),
            })
        }
    }

    #[async_trait]
    impl ExecutorApprovalService for FakeApprovals {
        async fn create_tool_approval(&self, _: &str) -> Result<String, ExecutorApprovalError> {
            unreachable!("tools other than questions are never sent for approval")
        }

        async fn create_question_approval(
            &self,
            tool_name: &str,
            tool_input: Value,
        ) -> Result<String, ExecutorApprovalError> {
            assert_eq!(tool_name, QUESTION_TOOL);
            self.asked.lock().unwrap().push(tool_input);
            Ok("approval-1".to_string())
        }

        async fn wait_tool_approval(
            &self,
            _: &str,
            _: CancellationToken,
        ) -> Result<ApprovalStatus, ExecutorApprovalError> {
            unreachable!()
        }

        async fn wait_question_answer(
            &self,
            approval_id: &str,
            _: CancellationToken,
        ) -> Result<QuestionStatus, ExecutorApprovalError> {
            assert_eq!(approval_id, "approval-1");
            self.outcome.lock().unwrap().take().expect("one question")
        }
    }

    /// One fake CLI: write its stdout, read what chro sends on its stdin, and
    /// read what chro mirrors into the log stream.
    struct Harness {
        cli_stdout: DuplexStream,
        cli_stdin: tokio::io::Lines<BufReader<DuplexStream>>,
        log: tokio::io::Lines<BufReader<DuplexStream>>,
        task: JoinHandle<()>,
    }

    fn start(approvals: Option<Arc<dyn ExecutorApprovalService>>) -> Harness {
        let (stdin_writer, stdin_reader) = duplex(64 * 1024);
        let (stdout_writer, stdout_reader) = duplex(64 * 1024);
        let (log_writer, log_reader) = duplex(64 * 1024);
        let task = ControlChannel::start(
            stdin_writer,
            stdout_reader,
            LogWriter::new(log_writer),
            approvals,
            CancellationToken::new(),
            "Pick a name",
        );
        Harness {
            cli_stdout: stdout_writer,
            cli_stdin: BufReader::new(stdin_reader).lines(),
            log: BufReader::new(log_reader).lines(),
            task,
        }
    }

    async fn emit(harness: &mut Harness, line: Value) {
        harness
            .cli_stdout
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn next_json(lines: &mut tokio::io::Lines<BufReader<DuplexStream>>) -> Value {
        let line = lines.next_line().await.unwrap().expect("a line");
        serde_json::from_str(&line).unwrap()
    }

    fn can_use_tool(request_id: &str, tool: &str, input: Value) -> Value {
        json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "can_use_tool", "tool_name": tool, "input": input },
        })
    }

    fn question_input() -> Value {
        json!({ "questions": [{
            "question": "Which name?",
            "header": "Name",
            "options": [{ "label": "todo.md", "description": "" }, { "label": "notes.md", "description": "" }],
            "multiSelect": false,
        }]})
    }

    #[tokio::test]
    async fn sends_the_prompt_as_a_stream_json_user_message() {
        let mut harness = start(None);
        assert_eq!(
            next_json(&mut harness.cli_stdin).await,
            json!({ "type": "user", "message": { "role": "user", "content": "Pick a name" } })
        );
    }

    #[tokio::test]
    async fn mirrors_output_but_not_control_traffic() {
        let mut harness = start(None);
        next_json(&mut harness.cli_stdin).await;
        emit(&mut harness, json!({ "type": "system", "subtype": "init" })).await;
        emit(
            &mut harness,
            json!({ "type": "control_cancel_request", "request_id": "x" }),
        )
        .await;
        emit(&mut harness, json!({ "type": "assistant", "message": {} })).await;
        assert_eq!(next_json(&mut harness.log).await["type"], "system");
        assert_eq!(next_json(&mut harness.log).await["type"], "assistant");
    }

    #[tokio::test]
    async fn allows_other_tools_unchanged() {
        let mut harness = start(None);
        next_json(&mut harness.cli_stdin).await;
        emit(
            &mut harness,
            can_use_tool("r1", "Bash", json!({ "command": "ls" })),
        )
        .await;
        assert_eq!(
            next_json(&mut harness.cli_stdin).await,
            success("r1", allow(json!({ "command": "ls" })))
        );
    }

    #[tokio::test]
    async fn returns_answers_from_the_question_approval() {
        let approvals = FakeApprovals::answering(Ok(QuestionStatus::Answered {
            answers: HashMap::from([("Which name?".to_string(), "todo.md".to_string())]),
        }));
        let mut harness = start(Some(approvals.clone()));
        next_json(&mut harness.cli_stdin).await;
        emit(
            &mut harness,
            can_use_tool("r2", QUESTION_TOOL, question_input()),
        )
        .await;

        let response = next_json(&mut harness.cli_stdin).await;
        let mut expected = question_input();
        expected["answers"] = json!({ "Which name?": "todo.md" });
        assert_eq!(response, success("r2", allow(expected)));
        assert_eq!(
            approvals.asked.lock().unwrap().as_slice(),
            &[question_input()]
        );
    }

    #[tokio::test]
    async fn denies_a_skipped_question() {
        let approvals = FakeApprovals::answering(Ok(QuestionStatus::Resolved { approved: false }));
        let mut harness = start(Some(approvals));
        next_json(&mut harness.cli_stdin).await;
        emit(
            &mut harness,
            can_use_tool("r3", QUESTION_TOOL, question_input()),
        )
        .await;
        assert_eq!(
            next_json(&mut harness.cli_stdin).await,
            success("r3", deny(QUESTIONS_SKIPPED))
        );
    }

    #[tokio::test]
    async fn denies_questions_when_no_one_can_answer() {
        let mut harness = start(None);
        next_json(&mut harness.cli_stdin).await;
        emit(
            &mut harness,
            can_use_tool("r4", QUESTION_TOOL, question_input()),
        )
        .await;
        assert_eq!(
            next_json(&mut harness.cli_stdin).await,
            success("r4", deny(NO_QUESTION_CHANNEL))
        );
    }

    #[tokio::test]
    async fn refuses_control_requests_it_does_not_serve() {
        let mut harness = start(None);
        next_json(&mut harness.cli_stdin).await;
        emit(
            &mut harness,
            json!({ "type": "control_request", "request_id": "r5", "request": { "subtype": "hook_callback" } }),
        )
        .await;
        assert_eq!(
            next_json(&mut harness.cli_stdin).await,
            failure("r5", "unsupported control request")
        );
    }

    #[tokio::test]
    async fn closes_stdin_after_the_turn_result_and_ends_with_stdout() {
        let mut harness = start(None);
        next_json(&mut harness.cli_stdin).await;
        emit(
            &mut harness,
            json!({ "type": "result", "subtype": "success" }),
        )
        .await;
        assert_eq!(next_json(&mut harness.log).await["type"], "result");
        assert_eq!(
            harness.cli_stdin.next_line().await.unwrap(),
            None,
            "stdin closed"
        );

        drop(harness.cli_stdout);
        harness.task.await.unwrap();
    }

    #[test]
    fn timed_out_and_cancelled_questions_are_denied() {
        assert_eq!(
            question_decision(question_input(), Ok(QuestionStatus::TimedOut)),
            deny(QUESTIONS_TIMED_OUT)
        );
        assert_eq!(
            question_decision(question_input(), Err(ExecutorApprovalError::Cancelled)),
            deny(QUESTIONS_CANCELLED)
        );
    }
}
