//! Regression test for the pi executor's run lifecycle against a fake
//! `pi --mode rpc` process.
//!
//! The container finalizes a run only after the executor's synthetic stdout
//! pipe reaches EOF, which requires every `PiClient` handle (and thus the
//! pipe's write end) to be dropped once the run ends. A task that outlives the
//! process while holding a handle wedges the run in "loading" forever. This
//! test drives a real `Pi::spawn` against a scripted fake and asserts the
//! synthetic stdout closes promptly after `agent_end`.

use std::time::Duration;

use executors::{ExecutionEnv, ExecutorExitResult, Pi, RepoContext, StandardCodingAgentExecutor};
use tokio::io::{AsyncBufReadExt, BufReader};

/// A minimal `pi --mode rpc` stand-in: answers `get_state`, acknowledges
/// `prompt`, streams one assistant message, then ends the turn. It keeps
/// reading stdin afterwards (like real pi, which stays alive between turns) so
/// the test proves EOF comes from handle drops, not from the process exiting.
const FAKE_PI: &str = r#"#!/usr/bin/env bash
while IFS= read -r line; do
  case "$line" in
    *'"get_state"'*)
      printf '%s\n' '{"type":"response","id":"1","command":"get_state","success":true,"data":{"sessionId":"fake-sess"}}'
      ;;
    *'"prompt"'*)
      printf '%s\n' '{"type":"response","id":"2","command":"prompt","success":true}'
      printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"hi from fake pi"}]}}'
      printf '%s\n' '{"type":"agent_end","willRetry":false,"messages":[]}'
      ;;
  esac
done
"#;

fn write_fake_pi(dir: &std::path::Path) -> std::path::PathBuf {
    let path = dir.join("fake-pi.sh");
    std::fs::write(&path, FAKE_PI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path
}

fn pi_with_fake(fake_path: &std::path::Path) -> Pi {
    let mut pi = Pi::default();
    pi.cmd.base_command_override = Some(fake_path.to_string_lossy().into_owned());
    pi
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn run_settles_after_agent_end_without_wedging_stdout() {
    let dir = std::env::temp_dir().join(format!("chro-pi-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let fake = write_fake_pi(&dir);

    let pi = pi_with_fake(&fake);
    let env = ExecutionEnv::new(RepoContext::new(dir.clone(), vec![]), false, String::new());

    let mut spawned = pi.spawn(&dir, "say hi", &env).await.expect("spawn");
    let exit_signal = spawned.exit_signal.take().expect("exit signal");
    let stdout = spawned.child.take_stdout().expect("synthetic stdout");

    // Drain the synthetic stdout to EOF. If any task leaks a PiClient handle,
    // the pipe's write end never closes and this loop hangs until the timeout —
    // the exact failure mode that wedged the UI in a loading state.
    let drain = async {
        let mut reader = BufReader::new(stdout).lines();
        let mut lines = Vec::new();
        while let Some(line) = reader.next_line().await.expect("read synthetic stdout") {
            if !line.trim().is_empty() {
                lines.push(line);
            }
        }
        lines
    };

    let lines = tokio::time::timeout(Duration::from_secs(20), drain)
        .await
        .expect("synthetic stdout never reached EOF: a PiClient handle leaked");

    assert!(
        lines.iter().any(|l| l.contains("\"agent_end\"")),
        "expected agent_end in stream: {lines:?}"
    );
    assert!(
        lines.iter().any(|l| l.contains("fake-sess")),
        "expected the get_state response to be mirrored: {lines:?}"
    );

    let exit = tokio::time::timeout(Duration::from_secs(5), exit_signal)
        .await
        .expect("exit signal never fired")
        .expect("exit signal channel dropped");
    assert!(
        matches!(exit, ExecutorExitResult::Success),
        "expected successful completion"
    );

    let _ = spawned.child.terminate().await;
    std::fs::remove_dir_all(&dir).ok();
}
