//! Materialize referenced-session context into the executor prompt.
//!
//! A `kind = "session"` context ref stores the relationship; the referenced
//! content is injected here at start-of-execution so the baseline context
//! never depends on the agent shelling out to the CLI. The full transcript
//! stays reachable via `chro task logs <task_id>` as an escalation path.
//!
//! The transform is a pure function of (prompt, digests): it touches only the
//! executor prompt, so retries and resumes re-derive it without stored state.

use db::types::RunStatus;

/// Digest of one referenced session, resolved server-side.
#[derive(Debug, Clone, Default)]
pub struct SessionContextDigest {
    pub task_id: String,
    pub title: String,
    pub branch: Option<String>,
    pub status: Option<String>,
    pub last_user: Option<String>,
    pub last_assistant: Option<String>,
}

/// Per-field cap for the last-exchange user/assistant texts.
pub const SESSION_CONTEXT_FIELD_MAX_CHARS: usize = 1_500;
/// Cap for one rendered `<session_context>` block.
pub const SESSION_CONTEXT_BLOCK_MAX_CHARS: usize = 4_000;
/// Refs beyond this count render header + escalation line only.
pub const SESSION_CONTEXT_MAX_FULL_REFS: usize = 5;
/// Cap for everything this module appends to a prompt. Refs that do not fit
/// are dropped; their `<past_session>` tags in the prompt still carry the
/// escalation pointer.
pub const SESSION_CONTEXT_TOTAL_MAX_CHARS: usize = 16_000;

const TRUNCATION_MARKER: &str = "… [truncated]";
const TITLE_MAX_CHARS: usize = 200;

pub fn run_status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Pending => "pending",
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
    }
}

/// Append rendered digests to the executor prompt. Returns the prompt
/// unchanged when there is nothing to materialize.
pub fn apply_session_context(prompt: &str, digests: &[SessionContextDigest]) -> String {
    if digests.is_empty() {
        return prompt.to_string();
    }

    let mut appended = String::new();
    for (index, digest) in digests.iter().enumerate() {
        let with_body = index < SESSION_CONTEXT_MAX_FULL_REFS;
        let mut block = render_block(digest, with_body);
        if appended.chars().count() + block.chars().count() > SESSION_CONTEXT_TOTAL_MAX_CHARS {
            block = render_block(digest, false);
            if appended.chars().count() + block.chars().count() > SESSION_CONTEXT_TOTAL_MAX_CHARS {
                break;
            }
        }
        if !appended.is_empty() {
            appended.push('\n');
        }
        appended.push_str(&block);
    }

    if appended.is_empty() {
        return prompt.to_string();
    }
    format!("{prompt}\n\n{appended}")
}

fn render_block(digest: &SessionContextDigest, with_body: bool) -> String {
    let mut attrs = format!(" task_id=\"{}\"", escape_xml_attr(&digest.task_id));
    if let Some(branch) = digest.branch.as_deref().filter(|value| !value.is_empty()) {
        attrs.push_str(&format!(" branch=\"{}\"", escape_xml_attr(branch)));
    }
    if let Some(status) = digest.status.as_deref().filter(|value| !value.is_empty()) {
        attrs.push_str(&format!(" status=\"{}\"", escape_xml_attr(status)));
    }

    let (title, _) = truncate_chars(digest.title.trim(), TITLE_MAX_CHARS);
    let footer = format!(
        "Full transcript: `chro task logs {}`\n</session_context>",
        digest.task_id
    );
    let header = format!("<session_context{attrs}>\n# {title}\n");

    let body = if with_body {
        let fixed_chars = header.chars().count() + footer.chars().count();
        let budget = SESSION_CONTEXT_BLOCK_MAX_CHARS.saturating_sub(fixed_chars);
        render_last_exchange(digest, budget)
    } else {
        String::new()
    };

    format!("{header}{body}{footer}")
}

fn render_last_exchange(digest: &SessionContextDigest, budget_chars: usize) -> String {
    let user = digest
        .last_user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let assistant = digest
        .last_assistant
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if user.is_none() && assistant.is_none() {
        return String::new();
    }

    let mut body = String::from("## Last exchange\n");
    if let Some(text) = user {
        let (text, _) = truncate_chars(text, SESSION_CONTEXT_FIELD_MAX_CHARS);
        body.push_str(&format!("User: {text}\n"));
    }
    if let Some(text) = assistant {
        let (text, _) = truncate_chars(text, SESSION_CONTEXT_FIELD_MAX_CHARS);
        body.push_str(&format!("Assistant: {text}\n"));
    }

    if body.chars().count() > budget_chars {
        let (clipped, _) = truncate_chars(&body, budget_chars.saturating_sub(1));
        body = format!("{clipped}\n");
    }
    body
}

fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    let kept: String = text
        .chars()
        .take(max_chars.saturating_sub(TRUNCATION_MARKER.chars().count()))
        .collect();
    (format!("{kept}{TRUNCATION_MARKER}"), true)
}

fn escape_xml_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(task_id: &str) -> SessionContextDigest {
        SessionContextDigest {
            task_id: task_id.to_string(),
            title: "Fix login flow".to_string(),
            branch: Some("ch/1234-login".to_string()),
            status: Some("completed".to_string()),
            last_user: Some("please fix the login redirect".to_string()),
            last_assistant: Some("Fixed by rewriting the redirect guard.".to_string()),
        }
    }

    #[test]
    fn no_digests_returns_prompt_unchanged() {
        let prompt = "<context>\n<past_session task_id=\"abc\" />\n</context>\nfix it";
        assert_eq!(apply_session_context(prompt, &[]), prompt);
    }

    #[test]
    fn one_digest_renders_full_block_after_prompt() {
        let out = apply_session_context("fix it", &[digest("abc-123")]);
        assert!(out.starts_with("fix it\n\n<session_context task_id=\"abc-123\""));
        assert!(out.contains("branch=\"ch/1234-login\""));
        assert!(out.contains("status=\"completed\""));
        assert!(out.contains("# Fix login flow"));
        assert!(out.contains("## Last exchange"));
        assert!(out.contains("User: please fix the login redirect"));
        assert!(out.contains("Assistant: Fixed by rewriting the redirect guard."));
        assert!(out.contains("Full transcript: `chro task logs abc-123`"));
        assert!(out.trim_end().ends_with("</session_context>"));
    }

    #[test]
    fn missing_exchange_renders_header_and_escalation_only() {
        let bare = SessionContextDigest {
            task_id: "abc".to_string(),
            title: "Fix login flow".to_string(),
            ..Default::default()
        };
        let out = apply_session_context("fix it", &[bare]);
        assert!(out.contains("<session_context task_id=\"abc\">"));
        assert!(!out.contains("## Last exchange"));
        assert!(!out.contains("branch="));
        assert!(out.contains("Full transcript: `chro task logs abc`"));
    }

    #[test]
    fn long_fields_are_truncated_with_marker() {
        let mut d = digest("abc");
        d.last_assistant = Some("x".repeat(SESSION_CONTEXT_FIELD_MAX_CHARS * 3));
        let out = apply_session_context("fix it", &[d]);
        assert!(out.contains(TRUNCATION_MARKER));
        let assistant_line = out
            .lines()
            .find(|line| line.starts_with("Assistant: "))
            .unwrap();
        assert!(assistant_line.chars().count() <= SESSION_CONTEXT_FIELD_MAX_CHARS + 20);
    }

    #[test]
    fn block_stays_within_block_cap() {
        let mut d = digest("abc");
        d.last_user = Some("u".repeat(SESSION_CONTEXT_FIELD_MAX_CHARS * 2));
        d.last_assistant = Some("a".repeat(SESSION_CONTEXT_FIELD_MAX_CHARS * 2));
        d.title = "t".repeat(TITLE_MAX_CHARS * 2);
        let out = apply_session_context("", &[d]);
        assert!(out.chars().count() <= SESSION_CONTEXT_BLOCK_MAX_CHARS + 10);
    }

    #[test]
    fn refs_beyond_full_limit_render_without_body() {
        let digests: Vec<_> = (0..SESSION_CONTEXT_MAX_FULL_REFS + 1)
            .map(|i| digest(&format!("task-{i}")))
            .collect();
        let out = apply_session_context("fix it", &digests);
        let last_id = format!("task-{}", SESSION_CONTEXT_MAX_FULL_REFS);
        let last_block = out
            .split(&format!("<session_context task_id=\"{last_id}\""))
            .nth(1)
            .unwrap();
        assert!(!last_block.contains("## Last exchange"));
        assert!(last_block.contains(&format!("chro task logs {last_id}")));
        assert_eq!(
            out.matches("## Last exchange").count(),
            SESSION_CONTEXT_MAX_FULL_REFS
        );
    }

    #[test]
    fn total_cap_bounds_appended_output() {
        let digests: Vec<_> = (0..100)
            .map(|i| {
                let mut d = digest(&format!("task-{i}"));
                d.last_user = Some("u".repeat(SESSION_CONTEXT_FIELD_MAX_CHARS));
                d.last_assistant = Some("a".repeat(SESSION_CONTEXT_FIELD_MAX_CHARS));
                d
            })
            .collect();
        let prompt = "fix it";
        let out = apply_session_context(prompt, &digests);
        let appended = out.chars().count() - prompt.chars().count();
        assert!(appended <= SESSION_CONTEXT_TOTAL_MAX_CHARS + 10);
    }

    #[test]
    fn attribute_values_are_escaped() {
        let mut d = digest("a\"b<c>");
        d.branch = Some("feat/\"quoted\"".to_string());
        let out = apply_session_context("fix it", &[d]);
        assert!(out.contains("task_id=\"a&quot;b&lt;c&gt;\""));
        assert!(out.contains("branch=\"feat/&quot;quoted&quot;\""));
    }
}
