//! Pure flatten of per-run conversation state into one chronological list.
//!
//! Ported from `flattenConversationEntries` in
//! `apps/desktop/src/session/domain/conversation-history.ts`. The JS
//! memoization cache (`createConversationFlattenCache`) is a React
//! object-identity perf concern and is intentionally NOT ported; this is the
//! pure transformation only.

use std::collections::HashMap;

use crate::types::{
    DisplayEntry, NormalizedEntry, NormalizedEntryType, TaskRunConversationState,
    TaskRunPromptOverride, TaskSessionRecord,
};

/// Options controlling flatten behavior (`FlattenConversationEntriesOptions`).
#[derive(Debug, Clone, Default)]
pub struct FlattenOptions {
    /// Prompt overrides keyed by `task_run_id`, applied before session prompts.
    pub prompt_overrides_by_run: HashMap<String, TaskRunPromptOverride>,
    /// Run ids that should receive a trailing loading sentinel.
    pub loading_run_ids: Vec<String>,
}

fn is_normalized_user_message(entry: &DisplayEntry) -> bool {
    matches!(
        entry.normalized(),
        Some(NormalizedEntry {
            entry_type: NormalizedEntryType::UserMessage,
            ..
        })
    )
}

/// Index sessions by run id, keeping only rows that have a run id and a
/// non-blank prompt. Mirrors `buildTaskSessionPromptMap`.
pub fn build_task_session_prompt_map(
    sessions: &[TaskSessionRecord],
) -> HashMap<String, TaskSessionRecord> {
    let mut prompt_by_run: HashMap<String, TaskSessionRecord> = HashMap::new();
    for session in sessions {
        let Some(task_run_id) = session.task_run_id.as_ref() else {
            continue;
        };
        let has_prompt = session
            .prompt
            .as_ref()
            .is_some_and(|prompt| !prompt.trim().is_empty());
        if !has_prompt {
            continue;
        }
        prompt_by_run.insert(task_run_id.clone(), session.clone());
    }
    prompt_by_run
}

/// Drop log `user_message` entries when requested. Mirrors
/// `filterConversationLogEntries`.
pub fn filter_conversation_log_entries(
    entries: &[DisplayEntry],
    exclude_user_messages: bool,
) -> Vec<DisplayEntry> {
    if !exclude_user_messages {
        return entries.to_vec();
    }
    entries
        .iter()
        .filter(|entry| !is_normalized_user_message(entry))
        .cloned()
        .collect()
}

/// Build the synthetic user-prompt entry injected ahead of a run's log when a
/// session prompt override exists. Mirrors `createSyntheticUserMessageEntry`.
pub fn create_synthetic_user_message_entry(
    task_run_id: &str,
    prompt: &str,
    session_id: Option<&str>,
    created_at: Option<&str>,
) -> DisplayEntry {
    let id = match session_id {
        Some(session_id) => format!("synthetic-user-{session_id}"),
        None => format!("synthetic-user-{task_run_id}"),
    };
    DisplayEntry::Normalized {
        key: format!("{task_run_id}:{id}"),
        content: NormalizedEntry {
            id,
            // The backend never stamps user_message entries, so the run's
            // creation time is the most accurate moment the user sent this prompt.
            timestamp: created_at.map(str::to_string),
            entry_type: NormalizedEntryType::UserMessage,
            content: prompt.to_string(),
            metadata: None,
        },
    }
}

/// Build the trailing loading sentinel for an in-flight run. Mirrors
/// `createLoadingEntry`.
pub fn create_loading_entry(task_run_id: &str) -> DisplayEntry {
    let id = format!("loading-{task_run_id}");
    DisplayEntry::Normalized {
        key: format!("{task_run_id}:{id}"),
        content: NormalizedEntry {
            id,
            timestamp: None,
            entry_type: NormalizedEntryType::Loading,
            content: String::new(),
            metadata: None,
        },
    }
}

/// Resolve the effective prompt per run: prompt overrides first (blank prompts
/// skipped), then session prompts win. Mirrors `resolvePromptByRun`.
fn resolve_prompt_by_run(
    sessions: &[TaskSessionRecord],
    options: &FlattenOptions,
) -> HashMap<String, TaskRunPromptOverride> {
    let mut prompt_by_run: HashMap<String, TaskRunPromptOverride> = HashMap::new();

    for (task_run_id, override_) in &options.prompt_overrides_by_run {
        if override_.prompt.trim().is_empty() {
            continue;
        }
        prompt_by_run.insert(task_run_id.clone(), override_.clone());
    }

    for (task_run_id, session) in build_task_session_prompt_map(sessions) {
        prompt_by_run.insert(
            task_run_id,
            TaskRunPromptOverride {
                prompt: session.prompt.unwrap_or_default(),
                session_id: Some(session.id),
            },
        );
    }

    prompt_by_run
}

/// Assemble one run's slice: optional synthetic prompt, filtered log, optional
/// trailing loading entry. Mirrors `buildRunSlice` (without the memo cache).
fn build_run_slice(
    state: &TaskRunConversationState,
    prompt_override: Option<&TaskRunPromptOverride>,
    is_loading: bool,
) -> Vec<DisplayEntry> {
    let session_prompt = prompt_override.map(|override_| override_.prompt.as_str());
    let exclude_user_messages = session_prompt.is_some();

    let synthetic = session_prompt.map(|prompt| {
        create_synthetic_user_message_entry(
            &state.task_run_id,
            prompt,
            prompt_override.and_then(|override_| override_.session_id.as_deref()),
            Some(state.created_at.as_str()),
        )
    });

    let filtered_log = filter_conversation_log_entries(&state.entries, exclude_user_messages);

    let loading_entry = if is_loading {
        Some(create_loading_entry(&state.task_run_id))
    } else {
        None
    };

    let mut entries: Vec<DisplayEntry> = Vec::new();
    if let Some(synthetic) = synthetic {
        entries.push(synthetic);
    }
    entries.extend(filtered_log);
    if let Some(loading_entry) = loading_entry {
        entries.push(loading_entry);
    }
    entries
}

/// Flatten per-run states into a single chronological conversation, ordered by
/// `created_at`, with synthetic prompts, user-message filtering, and loading
/// sentinels applied. Mirrors `flattenConversationEntries`.
pub fn flatten_conversation_entries(
    states: &[TaskRunConversationState],
    sessions: &[TaskSessionRecord],
    options: &FlattenOptions,
) -> Vec<DisplayEntry> {
    let prompt_by_run = resolve_prompt_by_run(sessions, options);
    let loading_run_ids: std::collections::HashSet<&str> =
        options.loading_run_ids.iter().map(String::as_str).collect();

    // Stable sort by created_at, matching JS Array.prototype.sort (stable) over
    // `new Date(createdAt).getTime()`.
    let mut order: Vec<&TaskRunConversationState> = states.iter().collect();
    order.sort_by(|a, b| {
        timestamp_ms(&a.created_at).cmp(&timestamp_ms(&b.created_at))
    });

    order
        .into_iter()
        .flat_map(|state| {
            build_run_slice(
                state,
                prompt_by_run.get(&state.task_run_id),
                loading_run_ids.contains(state.task_run_id.as_str()),
            )
        })
        .collect()
}

/// Parse an ISO-8601 / RFC3339 UTC timestamp into epoch milliseconds for
/// ordering, faithfully reproducing JS `new Date(value).getTime()` for the
/// timestamps the backend emits (`YYYY-MM-DDTHH:MM:SS[.sss]Z`). Unparseable
/// values sort first as `i64::MIN`, matching `NaN` comparisons collapsing to
/// equality but keeping the input order stable.
fn timestamp_ms(value: &str) -> i64 {
    parse_iso8601_utc_ms(value).unwrap_or(i64::MIN)
}

fn parse_iso8601_utc_ms(value: &str) -> Option<i64> {
    // Expected: YYYY-MM-DDTHH:MM:SS(.fff)?(Z)
    let bytes = value.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    expect_char(bytes, 4, b'-')?;
    let month: i64 = value.get(5..7)?.parse().ok()?;
    expect_char(bytes, 7, b'-')?;
    let day: i64 = value.get(8..10)?.parse().ok()?;
    expect_char(bytes, 10, b'T')?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    expect_char(bytes, 13, b':')?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    expect_char(bytes, 16, b':')?;
    let second: i64 = value.get(17..19)?.parse().ok()?;

    let mut millis: i64 = 0;
    let mut rest = &value[19..];
    if let Some(stripped) = rest.strip_prefix('.') {
        // Take up to three fractional digits (millisecond precision, like JS).
        let frac: String = stripped.chars().take_while(char::is_ascii_digit).collect();
        let consumed = frac.len();
        let frac_ms: String = frac.chars().take(3).collect();
        let padded = format!("{frac_ms:0<3}");
        millis = padded.parse().ok()?;
        rest = &stripped[consumed..];
    }
    // Trailing zone designator must be UTC (Z) or empty for these inputs.
    if !rest.is_empty() && rest != "Z" {
        return None;
    }

    let days = days_from_civil(year, month, day)?;
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(seconds * 1_000 + millis)
}

fn expect_char(bytes: &[u8], index: usize, expected: u8) -> Option<()> {
    if bytes.get(index) == Some(&expected) {
        Some(())
    } else {
        None
    }
}

/// Days since the Unix epoch (1970-01-01) for a proleptic-Gregorian date.
/// Algorithm from Howard Hinnant's date math (public-domain reference).
fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DisplayEntry;

    // ---- Test fixtures mirroring conversation-history.test.ts helpers ----

    fn make_session(
        id: &str,
        task_run_id: Option<&str>,
        prompt: Option<&str>,
    ) -> TaskSessionRecord {
        TaskSessionRecord {
            id: id.to_string(),
            task_run_id: task_run_id.map(str::to_string),
            prompt: prompt.map(str::to_string),
        }
    }

    fn default_session() -> TaskSessionRecord {
        make_session("session-1", Some("run-1"), Some("Follow up prompt"))
    }

    fn make_user_message_entry(run_id: &str, content: &str) -> DisplayEntry {
        DisplayEntry::Normalized {
            key: format!("{run_id}:user-1"),
            content: NormalizedEntry {
                id: "user-1".to_string(),
                timestamp: None,
                entry_type: NormalizedEntryType::UserMessage,
                content: content.to_string(),
                metadata: None,
            },
        }
    }

    fn make_assistant_entry(run_id: &str, id: &str, content: &str) -> DisplayEntry {
        DisplayEntry::Normalized {
            key: format!("{run_id}:{id}"),
            content: NormalizedEntry {
                id: id.to_string(),
                timestamp: None,
                entry_type: NormalizedEntryType::AssistantMessage,
                content: content.to_string(),
                metadata: None,
            },
        }
    }

    fn make_state(
        task_run_id: &str,
        created_at: &str,
        entries: Vec<DisplayEntry>,
    ) -> TaskRunConversationState {
        TaskRunConversationState {
            task_run_id: task_run_id.to_string(),
            created_at: created_at.to_string(),
            entries,
        }
    }

    // ---- buildTaskSessionPromptMap ----

    // TS: buildTaskSessionPromptMap > "indexes sessions by run id when prompt exists"
    #[test]
    fn indexes_sessions_by_run_id_when_prompt_exists() {
        let sessions = vec![
            default_session(),
            make_session("session-2", Some("run-2"), Some("Second prompt")),
            make_session("session-3", Some("run-3"), Some("   ")),
            make_session("session-4", None, Some("Follow up prompt")),
        ];
        let map = build_task_session_prompt_map(&sessions);

        assert_eq!(map.get("run-1").map(|s| s.id.as_str()), Some("session-1"));
        assert_eq!(map.get("run-2").map(|s| s.id.as_str()), Some("session-2"));
        assert!(!map.contains_key("run-3"));
        assert!(!map.contains_key("run-4"));
    }

    // ---- filterConversationLogEntries ----

    // TS: filterConversationLogEntries > "removes log user messages only when requested"
    #[test]
    fn removes_log_user_messages_only_when_requested() {
        let entries = vec![
            make_user_message_entry("run-1", "Prompt from logs"),
            make_assistant_entry("run-1", "assistant-1", "Assistant reply"),
        ];

        assert_eq!(
            filter_conversation_log_entries(&entries, true),
            vec![make_assistant_entry("run-1", "assistant-1", "Assistant reply")]
        );
        assert_eq!(filter_conversation_log_entries(&entries, false), entries);
    }

    // ---- createSyntheticUserMessageEntry ----

    // TS: createSyntheticUserMessageEntry > "creates a stable synthetic entry keyed by session id"
    #[test]
    fn creates_a_stable_synthetic_entry_keyed_by_session_id() {
        let entry = create_synthetic_user_message_entry(
            "run-1",
            "Follow up prompt",
            Some("session-9"),
            None,
        );
        assert_eq!(
            entry,
            DisplayEntry::Normalized {
                key: "run-1:synthetic-user-session-9".to_string(),
                content: NormalizedEntry {
                    id: "synthetic-user-session-9".to_string(),
                    timestamp: None,
                    entry_type: NormalizedEntryType::UserMessage,
                    content: "Follow up prompt".to_string(),
                    metadata: None,
                },
            }
        );
    }

    // TS: createSyntheticUserMessageEntry > "stamps the entry with the run creation time when provided"
    #[test]
    fn stamps_the_entry_with_the_run_creation_time_when_provided() {
        let entry = create_synthetic_user_message_entry(
            "run-1",
            "Follow up prompt",
            Some("session-9"),
            Some("2025-01-01T00:00:00.000Z"),
        );
        assert_eq!(
            entry,
            DisplayEntry::Normalized {
                key: "run-1:synthetic-user-session-9".to_string(),
                content: NormalizedEntry {
                    id: "synthetic-user-session-9".to_string(),
                    timestamp: Some("2025-01-01T00:00:00.000Z".to_string()),
                    entry_type: NormalizedEntryType::UserMessage,
                    content: "Follow up prompt".to_string(),
                    metadata: None,
                },
            }
        );
    }

    // ---- flattenConversationEntries ----

    // TS: flattenConversationEntries > "prepends a synthetic user message and removes duplicate log user messages"
    #[test]
    fn prepends_synthetic_and_removes_duplicate_log_user_messages() {
        let states = vec![make_state(
            "run-1",
            "2025-01-01T00:00:00.000Z",
            vec![
                make_user_message_entry("run-1", "Prompt from logs"),
                make_assistant_entry("run-1", "assistant-1", "Assistant reply"),
            ],
        )];

        let flattened =
            flatten_conversation_entries(&states, &[default_session()], &FlattenOptions::default());

        assert_eq!(
            flattened,
            vec![
                create_synthetic_user_message_entry(
                    "run-1",
                    "Follow up prompt",
                    Some("session-1"),
                    Some("2025-01-01T00:00:00.000Z"),
                ),
                make_assistant_entry("run-1", "assistant-1", "Assistant reply"),
            ]
        );
    }

    // TS: flattenConversationEntries > "preserves log user messages when no session prompt exists"
    #[test]
    fn preserves_log_user_messages_when_no_session_prompt_exists() {
        let states = vec![make_state(
            "run-2",
            "2025-01-01T00:00:00.000Z",
            vec![
                make_user_message_entry("run-2", "Prompt from logs"),
                make_assistant_entry("run-2", "assistant-1", "Assistant reply"),
            ],
        )];

        let sessions = vec![make_session("session-2", Some("run-2"), None)];
        let flattened =
            flatten_conversation_entries(&states, &sessions, &FlattenOptions::default());

        assert_eq!(
            flattened,
            vec![
                make_user_message_entry("run-2", "Prompt from logs"),
                make_assistant_entry("run-2", "assistant-1", "Assistant reply"),
            ]
        );
    }

    // TS: flattenConversationEntries > "orders runs by createdAt before flattening"
    #[test]
    fn orders_runs_by_created_at_before_flattening() {
        let states = vec![
            make_state(
                "run-2",
                "2025-01-02T00:00:00.000Z",
                vec![make_assistant_entry("run-2", "assistant-2", "Second reply")],
            ),
            make_state(
                "run-1",
                "2025-01-01T00:00:00.000Z",
                vec![make_assistant_entry("run-1", "assistant-1", "First reply")],
            ),
        ];

        let sessions = vec![
            make_session("session-1", Some("run-1"), Some("First prompt")),
            make_session("session-2", Some("run-2"), Some("Second prompt")),
        ];
        let flattened =
            flatten_conversation_entries(&states, &sessions, &FlattenOptions::default());

        let keys: Vec<&str> = flattened.iter().map(DisplayEntry::key).collect();
        assert_eq!(
            keys,
            vec![
                "run-1:synthetic-user-session-1",
                "run-1:assistant-1",
                "run-2:synthetic-user-session-2",
                "run-2:assistant-2",
            ]
        );
    }

    // TS: flattenConversationEntries > "applies prompt overrides for pending runs without sessions"
    #[test]
    fn applies_prompt_overrides_for_pending_runs_without_sessions() {
        let states = vec![make_state(
            "run-pending",
            "2025-01-01T00:00:00.000Z",
            vec![make_assistant_entry(
                "run-pending",
                "assistant-pending",
                "Pending reply",
            )],
        )];

        let mut overrides = HashMap::new();
        overrides.insert(
            "run-pending".to_string(),
            TaskRunPromptOverride {
                prompt: "Pending prompt".to_string(),
                session_id: None,
            },
        );
        let options = FlattenOptions {
            prompt_overrides_by_run: overrides,
            loading_run_ids: Vec::new(),
        };

        let flattened = flatten_conversation_entries(&states, &[], &options);

        assert_eq!(
            flattened,
            vec![
                create_synthetic_user_message_entry(
                    "run-pending",
                    "Pending prompt",
                    None,
                    Some("2025-01-01T00:00:00.000Z"),
                ),
                make_assistant_entry("run-pending", "assistant-pending", "Pending reply"),
            ]
        );
    }

    // TS: flattenConversationEntries > "appends loading indicators for specified runs"
    #[test]
    fn appends_loading_indicators_for_specified_runs() {
        let states = vec![make_state(
            "run-1",
            "2025-01-01T00:00:00.000Z",
            vec![make_assistant_entry("run-1", "assistant-1", "Assistant reply")],
        )];

        let options = FlattenOptions {
            prompt_overrides_by_run: HashMap::new(),
            loading_run_ids: vec!["run-1".to_string()],
        };
        let flattened = flatten_conversation_entries(&states, &[], &options);

        assert_eq!(
            flattened,
            vec![
                make_assistant_entry("run-1", "assistant-1", "Assistant reply"),
                create_loading_entry("run-1"),
            ]
        );
    }

    // ---- timestamp ordering parity with new Date(...).getTime() ----

    #[test]
    fn parses_iso_timestamps_to_epoch_millis() {
        // 1970-01-01T00:00:00.000Z == 0
        assert_eq!(parse_iso8601_utc_ms("1970-01-01T00:00:00.000Z"), Some(0));
        // 2025-01-01T00:00:00.000Z == 1735689600000 (matches Date.UTC)
        assert_eq!(
            parse_iso8601_utc_ms("2025-01-01T00:00:00.000Z"),
            Some(1_735_689_600_000)
        );
        // Fractional milliseconds are honored.
        assert_eq!(
            parse_iso8601_utc_ms("2025-01-01T00:00:00.250Z"),
            Some(1_735_689_600_250)
        );
        // Ordering across days is correct.
        assert!(
            parse_iso8601_utc_ms("2025-01-01T00:00:00.000Z")
                < parse_iso8601_utc_ms("2025-01-02T00:00:00.000Z")
        );
    }
}
