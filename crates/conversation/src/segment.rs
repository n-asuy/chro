//! Group a turn's entries into passthrough entries and thinking-steps runs.
//!
//! Ported from `segmentConversationEntries` and `stepEntrySummary` in
//! `apps/desktop/src/session/utils/agent-step-segments.ts`.

use crate::types::{
    ActionType, ConversationSegment, DisplayEntry, NormalizedEntry, NormalizedEntryType,
    ToolStatus,
};

fn is_empty_thinking(entry: &NormalizedEntry) -> bool {
    matches!(entry.entry_type, NormalizedEntryType::Thinking) && entry.content.trim().is_empty()
}

/// Working entries that fold into a thinking-steps run: thinking, tool calls,
/// and the trailing loading sentinel.
fn step_entry(entry: &DisplayEntry) -> Option<&NormalizedEntry> {
    let normalized = entry.normalized()?;
    match normalized.entry_type {
        NormalizedEntryType::Thinking
        | NormalizedEntryType::ToolUse { .. }
        | NormalizedEntryType::Loading => Some(normalized),
        _ => None,
    }
}

fn is_loading_entry(entry: &NormalizedEntry) -> bool {
    matches!(entry.entry_type, NormalizedEntryType::Loading)
}

fn is_pending_approval(entry: &NormalizedEntry) -> bool {
    matches!(
        &entry.entry_type,
        NormalizedEntryType::ToolUse {
            status: ToolStatus::PendingApproval { .. },
            ..
        }
    )
}

/// Split a turn's entries into passthrough entries and thinking-steps runs.
/// Empty thinking entries are dropped; any non-working entry breaks the run.
/// Mirrors `segmentConversationEntries`.
pub fn segment_conversation_entries(entries: &[DisplayEntry]) -> Vec<ConversationSegment> {
    let mut segments: Vec<ConversationSegment> = Vec::new();
    let mut run: Vec<DisplayEntry> = Vec::new();
    // The latest reasoning prose seen in this turn. Tool-only runs (the agent
    // narrated in an assistant message, then ran tools) inherit it so their
    // header stays prose instead of a raw command.
    let mut carried_thinking_summary: Option<String> = None;

    for entry in entries {
        if step_entry(entry).is_some() {
            // `step_entry` already proved this is a NORMALIZED_ENTRY.
            let normalized = entry.normalized().expect("step entry is normalized");
            if !is_empty_thinking(normalized) {
                run.push(entry.clone());
            }
            continue;
        }
        flush_run(&mut run, &mut segments, &mut carried_thinking_summary);
        segments.push(ConversationSegment::Entry {
            entry: entry.clone(),
            key: entry.key().to_string(),
        });
    }

    flush_run(&mut run, &mut segments, &mut carried_thinking_summary);
    segments
}

fn flush_run(
    run: &mut Vec<DisplayEntry>,
    segments: &mut Vec<ConversationSegment>,
    carried_thinking_summary: &mut Option<String>,
) {
    if run.is_empty() {
        return;
    }

    let last = run
        .last()
        .and_then(DisplayEntry::normalized)
        .expect("run holds only normalized entries");
    let awaiting_approval = run.iter().any(|entry| {
        entry
            .normalized()
            .is_some_and(is_pending_approval)
    });

    let mut thinking_summary: Option<String> = None;
    let mut tool_summary: Option<String> = None;
    for entry in run.iter().rev() {
        let normalized = entry.normalized().expect("run holds only normalized entries");
        let Some(summary) = step_entry_summary(normalized) else {
            continue;
        };
        if matches!(normalized.entry_type, NormalizedEntryType::Thinking) {
            thinking_summary = Some(summary);
            break;
        }
        if tool_summary.is_none() {
            tool_summary = Some(summary);
        }
    }
    if let Some(summary) = thinking_summary.clone() {
        *carried_thinking_summary = Some(summary);
    }

    let live = is_loading_entry(last) || awaiting_approval;
    let label = thinking_summary
        .or_else(|| carried_thinking_summary.clone())
        .or(tool_summary);
    let key = format!("steps:{}", run[0].key());

    segments.push(ConversationSegment::ThinkingSteps {
        entries: std::mem::take(run),
        live,
        awaiting_approval,
        label,
        key,
    });
}

fn first_non_empty_line(text: &str) -> Option<String> {
    for line in text.split('\n') {
        // split('\n') leaves the trailing '\r' from CRLF; trim() removes it.
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

/// Strip the markdown markers that commonly lead a thinking line so the header
/// reads as plain text (emphasis, inline code, headings, list bullets, quotes).
/// Mirrors `stripMarkdownMarkers`.
fn strip_markdown_markers(line: &str) -> String {
    let without_bold = replace_paired(line, "**");
    let without_italic = replace_single(&without_bold, '*');
    let without_code = replace_single(&without_italic, '`');
    let leading_stripped = strip_leading_markers(&without_code);
    leading_stripped.trim().to_string()
}

/// Replace `**inner**` with `inner` for every non-greedy paired run, matching
/// the JS regex `/\*\*([^*]+)\*\*/g` (the captured group forbids `*`).
fn replace_paired(input: &str, marker: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find(marker) {
        let after_open = &rest[open + marker.len()..];
        // Inner group is one-or-more chars that are not '*'.
        let inner_end = after_open.find('*');
        match inner_end {
            Some(end) if end > 0 && after_open[end..].starts_with(marker) => {
                out.push_str(&rest[..open]);
                out.push_str(&after_open[..end]);
                rest = &after_open[end + marker.len()..];
            }
            _ => {
                // No closing pair; emit through the opener and continue.
                out.push_str(&rest[..open + marker.len()]);
                rest = after_open;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Replace `Xinner X` (single-char marker) with `inner`, matching the JS regex
/// `/X([^X]+)X/g` where `X` is `*` or backtick. The inner group is one-or-more
/// characters that are not the marker.
fn replace_single(input: &str, marker: char) -> String {
    let marker_len = marker.len_utf8();
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find(marker) {
        let after_open = &rest[open + marker_len..];
        match after_open.find(marker) {
            // Closing marker exists with a non-empty inner run (which, being the
            // span up to the first marker, cannot itself contain the marker).
            Some(close) if close > 0 => {
                out.push_str(&rest[..open]);
                out.push_str(&after_open[..close]);
                rest = &after_open[close + marker_len..];
            }
            _ => {
                out.push_str(&rest[..open + marker_len]);
                rest = after_open;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Strip a leading run of `#`, `>`, `-`, `*`, or whitespace, matching the JS
/// regex `/^[#>\-*\s]+/`.
fn strip_leading_markers(input: &str) -> String {
    let trimmed = input.trim_start_matches(|c: char| {
        matches!(c, '#' | '>' | '-' | '*') || c.is_whitespace()
    });
    trimmed.to_string()
}

/// A one-line label for a working entry, used as the timeline header. Returns
/// `None` when the entry has nothing to show. Mirrors `stepEntrySummary`.
pub fn step_entry_summary(entry: &NormalizedEntry) -> Option<String> {
    if let NormalizedEntryType::ToolUse {
        tool_name,
        action_type,
        ..
    } = &entry.entry_type
    {
        return match action_type {
            ActionType::CommandRun { command, .. } => match first_non_empty_line(command) {
                Some(line) => Some(format!("$ {line}")),
                None => non_empty(tool_name),
            },
            ActionType::FileRead { path } | ActionType::FileEdit { path, .. } => {
                non_empty(path).or_else(|| non_empty(tool_name))
            }
            ActionType::Search { query } => {
                non_empty(query).or_else(|| non_empty(tool_name))
            }
            ActionType::WebFetch { url } => non_empty(url).or_else(|| non_empty(tool_name)),
            _ => non_empty(tool_name),
        };
    }

    let line = first_non_empty_line(&entry.content)?;
    if matches!(entry.entry_type, NormalizedEntryType::Thinking) {
        let stripped = strip_markdown_markers(&line);
        return if stripped.is_empty() {
            None
        } else {
            Some(stripped)
        };
    }
    // loading entries carry an optional progress message
    Some(line)
}

/// JS `value || null`: a non-empty string passes through, an empty one becomes
/// `None`.
fn non_empty(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DisplayEntry;
    use std::cell::Cell;

    thread_local! {
        static COUNTER: Cell<u64> = const { Cell::new(0) };
    }

    fn next_id() -> String {
        COUNTER.with(|c| {
            let n = c.get() + 1;
            c.set(n);
            format!("entry-{n}")
        })
    }

    // Mirrors the `normalized(entry_type, content)` test helper.
    fn normalized(entry_type: NormalizedEntryType, content: &str) -> DisplayEntry {
        let id = next_id();
        DisplayEntry::Normalized {
            key: id.clone(),
            content: NormalizedEntry {
                id,
                timestamp: None,
                entry_type,
                content: content.to_string(),
                metadata: None,
            },
        }
    }

    fn tool_use(status: ToolStatus) -> DisplayEntry {
        normalized(
            NormalizedEntryType::ToolUse {
                tool_name: "Bash".to_string(),
                action_type: ActionType::CommandRun {
                    command: "ls".to_string(),
                    result: None,
                },
                status,
            },
            "[Tool] ls",
        )
    }

    fn tool_use_default() -> DisplayEntry {
        tool_use(ToolStatus::Success)
    }

    fn thinking(content: &str) -> DisplayEntry {
        normalized(NormalizedEntryType::Thinking, content)
    }

    fn thinking_default() -> DisplayEntry {
        thinking("Reasoning about the task")
    }

    fn assistant(content: &str) -> DisplayEntry {
        normalized(NormalizedEntryType::AssistantMessage, content)
    }

    fn assistant_default() -> DisplayEntry {
        assistant("Done.")
    }

    fn loading() -> DisplayEntry {
        normalized(NormalizedEntryType::Loading, "")
    }

    fn stdout() -> DisplayEntry {
        let id = next_id();
        DisplayEntry::Stdout {
            content: "raw".to_string(),
            key: format!("stdout-{id}"),
        }
    }

    fn content_of(entry: &DisplayEntry) -> &NormalizedEntry {
        entry.normalized().expect("expected normalized entry")
    }

    fn segment_types(segments: &[ConversationSegment]) -> Vec<&'static str> {
        segments
            .iter()
            .map(|segment| match segment {
                ConversationSegment::Entry { .. } => "ENTRY",
                ConversationSegment::ThinkingSteps { .. } => "THINKING_STEPS",
            })
            .collect()
    }

    // ---- segmentConversationEntries ----

    // TS: "groups consecutive thinking and tool_use entries into one steps segment"
    #[test]
    fn groups_consecutive_thinking_and_tool_use_into_one_steps_segment() {
        let entries = vec![thinking_default(), tool_use_default(), tool_use_default()];
        let first_key = entries[0].key().to_string();
        let segments = segment_conversation_entries(&entries);

        assert_eq!(segments.len(), 1);
        match &segments[0] {
            ConversationSegment::ThinkingSteps {
                entries, live, key, ..
            } => {
                assert_eq!(entries.len(), 3);
                assert!(!live);
                assert_eq!(key, &format!("steps:{first_key}"));
            }
            other => panic!("expected THINKING_STEPS, got {other:?}"),
        }
    }

    // TS: "splits step runs on assistant messages"
    #[test]
    fn splits_step_runs_on_assistant_messages() {
        let segments = segment_conversation_entries(&[
            tool_use_default(),
            assistant_default(),
            tool_use_default(),
        ]);
        assert_eq!(
            segment_types(&segments),
            vec!["THINKING_STEPS", "ENTRY", "THINKING_STEPS"]
        );
    }

    // TS: "splits step runs on raw stdout/stderr output"
    #[test]
    fn splits_step_runs_on_raw_stdout_output() {
        let segments =
            segment_conversation_entries(&[tool_use_default(), stdout(), tool_use_default()]);
        assert_eq!(
            segment_types(&segments),
            vec!["THINKING_STEPS", "ENTRY", "THINKING_STEPS"]
        );
    }

    // TS: "marks a run live when it ends with a loading entry"
    #[test]
    fn marks_a_run_live_when_it_ends_with_a_loading_entry() {
        let segments = segment_conversation_entries(&[thinking_default(), loading()]);
        assert_eq!(segments.len(), 1);
        match &segments[0] {
            ConversationSegment::ThinkingSteps { live, entries, .. } => {
                assert!(live);
                assert_eq!(entries.len(), 2);
            }
            other => panic!("expected THINKING_STEPS, got {other:?}"),
        }
    }

    // TS: "marks a run live and awaiting approval while a tool waits for approval"
    #[test]
    fn marks_a_run_live_and_awaiting_approval_while_a_tool_waits() {
        let segments = segment_conversation_entries(&[tool_use(ToolStatus::PendingApproval {
            approval_id: "a1".to_string(),
            requested_at: "2026-01-01T00:00:00Z".to_string(),
            timeout_at: "2026-01-01T00:05:00Z".to_string(),
        })]);

        match &segments[0] {
            ConversationSegment::ThinkingSteps {
                live,
                awaiting_approval,
                ..
            } => {
                assert!(live);
                assert!(awaiting_approval);
            }
            other => panic!("expected THINKING_STEPS, got {other:?}"),
        }
    }

    // TS: "does not flag approval for a plain live run"
    #[test]
    fn does_not_flag_approval_for_a_plain_live_run() {
        let segments = segment_conversation_entries(&[thinking_default(), loading()]);
        match &segments[0] {
            ConversationSegment::ThinkingSteps {
                awaiting_approval, ..
            } => assert!(!awaiting_approval),
            other => panic!("expected THINKING_STEPS, got {other:?}"),
        }
    }

    // TS: "treats a lone loading entry as a live steps segment"
    #[test]
    fn treats_a_lone_loading_entry_as_a_live_steps_segment() {
        let segments = segment_conversation_entries(&[loading()]);
        assert_eq!(segments.len(), 1);
        match &segments[0] {
            ConversationSegment::ThinkingSteps { live, .. } => assert!(live),
            other => panic!("expected THINKING_STEPS, got {other:?}"),
        }
    }

    // TS: "drops empty thinking entries"
    #[test]
    fn drops_empty_thinking_entries() {
        let segments = segment_conversation_entries(&[thinking("  \n "), assistant_default()]);
        assert_eq!(segment_types(&segments), vec!["ENTRY"]);
    }

    // TS: "passes non-step entries through with their own keys"
    #[test]
    fn passes_non_step_entries_through_with_their_own_keys() {
        let message = assistant_default();
        let expected_key = message.key().to_string();
        let segments = segment_conversation_entries(std::slice::from_ref(&message));
        assert_eq!(
            segments,
            vec![ConversationSegment::Entry {
                entry: message,
                key: expected_key,
            }]
        );
    }

    // ---- stepEntrySummary ----

    // TS: "summarizes a command run as a shell line"
    #[test]
    fn summarizes_a_command_run_as_a_shell_line() {
        let entry = tool_use_default();
        assert_eq!(
            step_entry_summary(content_of(&entry)),
            Some("$ ls".to_string())
        );
    }

    // TS: "summarizes file actions with their path"
    #[test]
    fn summarizes_file_actions_with_their_path() {
        let entry = normalized(
            NormalizedEntryType::ToolUse {
                tool_name: "Read".to_string(),
                action_type: ActionType::FileRead {
                    path: "src/main.rs".to_string(),
                },
                status: ToolStatus::Success,
            },
            "",
        );
        assert_eq!(
            step_entry_summary(content_of(&entry)),
            Some("src/main.rs".to_string())
        );
    }

    // TS: "falls back to the tool name for other tools"
    #[test]
    fn falls_back_to_the_tool_name_for_other_tools() {
        let entry = normalized(
            NormalizedEntryType::ToolUse {
                tool_name: "WebSearch".to_string(),
                action_type: ActionType::Tool {
                    tool_name: "WebSearch".to_string(),
                    arguments: None,
                    result: None,
                },
                status: ToolStatus::Success,
            },
            "",
        );
        assert_eq!(
            step_entry_summary(content_of(&entry)),
            Some("WebSearch".to_string())
        );
    }

    // TS: "uses the first line of thinking content, stripped of markdown markers"
    #[test]
    fn uses_first_line_of_thinking_stripped_of_markdown() {
        let entry = thinking("**Checking** the build setup\nmore detail");
        assert_eq!(
            step_entry_summary(content_of(&entry)),
            Some("Checking the build setup".to_string())
        );
    }

    // TS: "returns null for loading entries without content"
    #[test]
    fn returns_none_for_loading_entries_without_content() {
        let entry = loading();
        assert_eq!(step_entry_summary(content_of(&entry)), None);
    }

    // ---- segment labels ----

    fn labels_of(entries: &[DisplayEntry]) -> Vec<Option<String>> {
        segment_conversation_entries(entries)
            .into_iter()
            .filter_map(|segment| match segment {
                ConversationSegment::ThinkingSteps { label, .. } => Some(label),
                ConversationSegment::Entry { .. } => None,
            })
            .collect()
    }

    // TS: "prefers the latest thinking prose over later tool calls"
    #[test]
    fn prefers_the_latest_thinking_prose_over_later_tool_calls() {
        assert_eq!(
            labels_of(&[
                thinking("Old idea"),
                thinking("Inspecting the build output"),
                tool_use_default(),
                tool_use_default(),
            ]),
            vec![Some("Inspecting the build output".to_string())]
        );
    }

    // TS: "carries the previous reasoning into tool-only runs of the same turn"
    #[test]
    fn carries_previous_reasoning_into_tool_only_runs() {
        assert_eq!(
            labels_of(&[
                thinking("Verifying the dev server"),
                assistant("Let me check."),
                tool_use_default(),
            ]),
            vec![
                Some("Verifying the dev server".to_string()),
                Some("Verifying the dev server".to_string()),
            ]
        );
    }

    // TS: "falls back to the tool summary when the turn has no reasoning"
    #[test]
    fn falls_back_to_the_tool_summary_when_no_reasoning() {
        assert_eq!(
            labels_of(&[tool_use_default(), loading()]),
            vec![Some("$ ls".to_string())]
        );
    }

    // TS: "labels a lone loading run as null for the caller's fallback"
    #[test]
    fn labels_a_lone_loading_run_as_none() {
        assert_eq!(labels_of(&[loading()]), vec![None]);
    }
}
