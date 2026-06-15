//! End-to-end test for the PTY-hosted Claude executor against the real CLI.
//!
//! Ignored by default: requires an installed, authenticated `claude` binary
//! and network access. Run explicitly with
//! `cargo test --test claude_pty_e2e -- --ignored --nocapture`.

use std::time::Duration;

use executors::{ClaudeCode, ExecutionEnv, RepoContext, StandardCodingAgentExecutor};
use tokio::io::{AsyncBufReadExt, BufReader};

struct RunOutput {
    lines: Vec<serde_json::Value>,
    session_id: Option<String>,
}

impl RunOutput {
    fn result(&self) -> &serde_json::Value {
        self.lines
            .iter()
            .rev()
            .find(|l| l["type"] == "result")
            .expect("run must end with a result line")
    }

    fn assistant_texts(&self) -> Vec<String> {
        self.lines
            .iter()
            .filter(|l| l["type"] == "assistant")
            .flat_map(|l| {
                l["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .filter(|block| block["type"] == "text")
            .filter_map(|block| block["text"].as_str().map(str::to_string))
            .collect()
    }
}

/// Drive one spawned run to its synthesized `result` line.
async fn collect_run(mut spawned: executors::SpawnedChild) -> RunOutput {
    let stdout = spawned.child.take_stdout().expect("synthetic stdout");
    let mut reader = BufReader::new(stdout).lines();
    let mut lines = Vec::new();
    let mut session_id = None;

    loop {
        let line = tokio::time::timeout(Duration::from_secs(120), reader.next_line())
            .await
            .expect("run stalled: no stdout line within 120s")
            .expect("stdout read failed");
        let Some(line) = line else { break };
        let value: serde_json::Value =
            serde_json::from_str(&line).expect("synthetic stdout must be valid stream-json");
        if session_id.is_none() {
            session_id = value
                .get("session_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
        }
        let is_result = value["type"] == "result";
        lines.push(value);
        if is_result {
            break;
        }
    }

    let _ = spawned.child.terminate().await;
    RunOutput { lines, session_id }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated claude CLI and network access"]
async fn pty_run_completes_and_resumes() {
    let dir = std::env::temp_dir().join(format!("chro-pty-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    let claude = ClaudeCode::default();
    let env = ExecutionEnv::new(RepoContext::new(dir.clone(), vec![]), false, String::new());

    // First turn.
    let spawned = claude
        .spawn(&dir, "Reply with exactly: pty-e2e-ok", &env)
        .await
        .expect("spawn");
    let first = collect_run(spawned).await;

    let result = first.result();
    assert_eq!(result["is_error"], false, "result: {result}");
    let session_id = first.session_id.clone().expect("session id extracted");
    assert!(
        first
            .assistant_texts()
            .iter()
            .any(|t| t.contains("pty-e2e-ok")),
        "assistant reply missing: {:?}",
        first.assistant_texts()
    );

    // Follow-up resumes the session and must not replay history.
    let spawned = claude
        .spawn_follow_up(
            &dir,
            "Repeat your previous reply, but in ALL CAPS.",
            &session_id,
            None,
            &env,
        )
        .await
        .expect("spawn follow-up");
    let second = collect_run(spawned).await;

    assert_eq!(second.result()["is_error"], false);
    let texts = second.assistant_texts();
    assert!(
        texts.iter().any(|t| t.contains("PTY-E2E-OK")),
        "follow-up did not carry session context: {texts:?}"
    );
    assert!(
        !texts.iter().any(|t| t.trim() == "pty-e2e-ok"),
        "resumed run replayed first-turn history: {texts:?}"
    );

    std::fs::remove_dir_all(&dir).ok();
}
