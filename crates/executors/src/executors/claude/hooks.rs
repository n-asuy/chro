//! Claude Code hook wiring for PTY-hosted runs.
//!
//! Instead of the deprecated `--print` stream-json protocol, a run is driven
//! by Claude Code hooks: a per-run settings file (passed via `--settings`)
//! registers shell commands that POST each hook payload to chro's per-run
//! HTTP endpoint. `UserPromptSubmit` discovers the transcript, `Stop` marks
//! turn completion, and `PreToolUse` carries the permission/question flow.

use std::path::PathBuf;

use serde_json::{Value, json};

use crate::profile::PermissionMode;

/// Where a run's hook receiver listens, plus its bearer token.
#[derive(Debug, Clone)]
pub struct HookEndpoint {
    pub port: u16,
    pub token: String,
}

pub const HOOK_TOKEN_HEADER: &str = "x-chro-hook-token";

/// Hook timeouts in seconds. Control events must answer fast; PreToolUse may
/// block on a human approval for a long time.
const CONTROL_HOOK_TIMEOUT_SECS: u64 = 30;
const PRE_TOOL_USE_HOOK_TIMEOUT_SECS: u64 = 86_400;

/// Whether a hook's stdout is forwarded back to Claude Code.
///
/// `PreToolUse` must return its permission decision, so its body is printed.
/// Control events (`UserPromptSubmit`, `Stop`, `Notification`) MUST stay
/// silent: Claude Code interprets any JSON a `Stop` hook prints as a
/// "continue" instruction, which on the next `--resume` shows up as a phantom
/// "Continue from where you left off." turn that corrupts the conversation.
/// Verified against claude 2.1.173.
#[derive(Clone, Copy)]
enum HookReply {
    Emit,
    Discard,
}

fn hook_post_command(endpoint: &HookEndpoint, reply: HookReply, timeout_secs: u64) -> String {
    let curl = if cfg!(windows) { "curl.exe" } else { "curl" };
    let post = format!(
        "{curl} -s --max-time {timeout_secs} -X POST \
         -H \"Content-Type: application/json\" \
         -H \"{HOOK_TOKEN_HEADER}: {token}\" \
         --data-binary @- \"http://127.0.0.1:{port}/hook\"",
        token = endpoint.token,
        port = endpoint.port,
    );
    match reply {
        HookReply::Emit => post,
        // Fire-and-forget: swallow the body and never fail the hook, so a
        // control event can never feed output back into the session.
        HookReply::Discard => format!("{post} >/dev/null 2>&1; exit 0"),
    }
}

/// Build the per-run settings JSON registering chro's hooks.
///
/// `PreToolUse` is scoped by permission mode: in bypass mode only
/// `AskUserQuestion` must be intercepted (to route questions to chro's UI);
/// in plan/approvals mode every tool goes through the permission broker.
pub fn build_hook_settings(endpoint: &HookEndpoint, mode: PermissionMode) -> Value {
    let control_command =
        hook_post_command(endpoint, HookReply::Discard, CONTROL_HOOK_TIMEOUT_SECS);
    let control_hook = || {
        json!([{
            "hooks": [{
                "type": "command",
                "command": control_command,
                "timeout": CONTROL_HOOK_TIMEOUT_SECS
            }]
        }])
    };
    let pre_tool_use_command =
        hook_post_command(endpoint, HookReply::Emit, PRE_TOOL_USE_HOOK_TIMEOUT_SECS);
    let pre_tool_use_matcher = match mode {
        PermissionMode::BypassPermissions => "AskUserQuestion",
        PermissionMode::Plan | PermissionMode::Default => "*",
    };

    json!({
        "hooks": {
            "UserPromptSubmit": control_hook(),
            "Stop": control_hook(),
            "Notification": control_hook(),
            "PreToolUse": [{
                "matcher": pre_tool_use_matcher,
                "hooks": [{
                    "type": "command",
                    "command": pre_tool_use_command,
                    "timeout": PRE_TOOL_USE_HOOK_TIMEOUT_SECS
                }]
            }]
        }
    })
}

/// Persist the settings to a per-run temp file consumable by `--settings`.
pub async fn write_hook_settings_file(
    settings: &Value,
    run_key: uuid::Uuid,
) -> std::io::Result<PathBuf> {
    let path = std::env::temp_dir().join(format!("chro-claude-hooks-{}.json", run_key.simple()));
    tokio::fs::write(&path, serde_json::to_vec_pretty(settings)?).await?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint() -> HookEndpoint {
        HookEndpoint {
            port: 4321,
            token: "secret".to_string(),
        }
    }

    #[test]
    fn hook_command_targets_run_endpoint_with_token() {
        let command = hook_post_command(&endpoint(), HookReply::Emit, 30);
        assert!(command.contains("http://127.0.0.1:4321/hook"));
        assert!(command.contains("x-chro-hook-token: secret"));
        assert!(command.contains("--data-binary @-"));
    }

    #[test]
    fn control_hooks_discard_output_pre_tool_use_emits_it() {
        // A control hook that prints a body makes Claude inject a phantom
        // "continue" turn on resume, so control events must stay silent.
        let settings = build_hook_settings(&endpoint(), PermissionMode::Default);
        for event in ["UserPromptSubmit", "Stop", "Notification"] {
            let command = settings["hooks"][event][0]["hooks"][0]["command"]
                .as_str()
                .unwrap();
            assert!(command.contains("/hook"), "control hook posts: {command}");
            assert!(
                command.contains(">/dev/null"),
                "control hook must discard stdout: {command}"
            );
        }
        let pre_tool_use = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(!pre_tool_use.contains(">/dev/null"));
    }

    #[test]
    fn bypass_mode_intercepts_only_questions() {
        let settings = build_hook_settings(&endpoint(), PermissionMode::BypassPermissions);
        let matcher = settings["hooks"]["PreToolUse"][0]["matcher"].as_str();
        assert_eq!(matcher, Some("AskUserQuestion"));
        for event in ["UserPromptSubmit", "Stop", "Notification"] {
            assert!(
                settings["hooks"][event][0]["hooks"][0]["command"]
                    .as_str()
                    .unwrap()
                    .contains("/hook")
            );
        }
    }

    #[test]
    fn plan_and_approvals_modes_intercept_all_tools() {
        for mode in [PermissionMode::Plan, PermissionMode::Default] {
            let settings = build_hook_settings(&endpoint(), mode);
            assert_eq!(
                settings["hooks"]["PreToolUse"][0]["matcher"].as_str(),
                Some("*")
            );
        }
    }

    #[test]
    fn pre_tool_use_hook_waits_for_human_approval() {
        let settings = build_hook_settings(&endpoint(), PermissionMode::Default);
        assert_eq!(
            settings["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"].as_u64(),
            Some(PRE_TOOL_USE_HOOK_TIMEOUT_SECS)
        );
    }
}
