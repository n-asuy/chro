//! `GET /v1/sessions/:session/entries`: the conversation as plain entries,
//! readable incrementally.
//!
//! Each turn's log is the same normalized conversation the app renders,
//! carried as JSON patches over an `/entries` array. Folding those patches
//! gives the turn's entries; the user's message comes from the turn's
//! recorded prompt, as the app shows it. A cursor names one entry as
//! `<turn index>.<position>`, so `since` returns exactly what follows it.

use axum::{
    extract::{Path, Query, State},
    Extension,
};
use db::{
    models::{TaskRun, TaskSession},
    types::RunStatus,
};
use futures::StreamExt;
use log_types::{LogEntry, NormalizedEntry, NormalizedEntryType};
use runtime::Runtime;
use serde_json::Value;
use server_contract::api::{Entries, EntriesQuery, EntryKind, EntryView};

use super::{selectors, Caller, V1Error, V1Result, V1};
use crate::AppState;

const DEFAULT_LIMIT: usize = 200;
/// Position of the user's message within its turn. The turn's own entries
/// follow from 1, and the turn-end marker takes the position after the last of
/// them; a finished turn gains no entries, so that position stays put.
const USER_POSITION: u64 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Cursor {
    turn: u64,
    position: u64,
}

impl Cursor {
    fn parse(raw: &str) -> Result<Self, V1Error> {
        let parsed = raw
            .split_once('.')
            .and_then(|(turn, position)| Some((turn.parse().ok()?, position.parse().ok()?)));
        match parsed {
            Some((turn, position)) => Ok(Cursor { turn, position }),
            None => Err(V1Error::invalid(format!(
                "'{raw}' is not a cursor; pass the next_cursor of an earlier read"
            ))),
        }
    }

    fn render(self) -> String {
        format!("{}.{}", self.turn, self.position)
    }
}

/// Apply conversation patches to an empty `/entries` array, with JSON Patch
/// array semantics (an add inserts, a remove shifts). Patches for anything
/// else (approvals, diffs) are ignored.
fn fold_patches<'a>(patches: impl IntoIterator<Item = &'a Value>) -> Vec<NormalizedEntry> {
    let mut entries: Vec<NormalizedEntry> = Vec::new();
    for patch in patches {
        let Some(ops) = patch.as_array() else {
            continue;
        };
        for op in ops {
            let Some(index) = op
                .get("path")
                .and_then(Value::as_str)
                .and_then(|path| path.strip_prefix("/entries/"))
                .and_then(|index| index.parse::<usize>().ok())
            else {
                continue;
            };
            let entry = || {
                let value = op.get("value")?;
                (value.get("type")?.as_str()? == "NORMALIZED_ENTRY")
                    .then(|| serde_json::from_value(value.get("content")?.clone()).ok())
                    .flatten()
            };
            match op.get("op").and_then(Value::as_str) {
                Some("add") => {
                    if let Some(entry) = entry() {
                        entries.insert(index.min(entries.len()), entry);
                    }
                }
                Some("replace") => {
                    if let (Some(entry), Some(slot)) = (entry(), entries.get_mut(index)) {
                        *slot = entry;
                    }
                }
                Some("remove") if index < entries.len() => {
                    entries.remove(index);
                }
                _ => {}
            }
        }
    }
    entries
}

fn tag(value: impl serde::Serialize, key: &str) -> Option<String> {
    let value = serde_json::to_value(value).ok()?;
    match value {
        Value::String(text) => Some(text),
        Value::Object(map) => map.get(key)?.as_str().map(str::to_string),
        _ => None,
    }
}

/// One turn's entries, before cursor filtering.
fn turn_entries(
    turn_index: u64,
    turn: &str,
    prompt: Option<&str>,
    normalized: &[NormalizedEntry],
    finished: Option<RunStatus>,
) -> Vec<EntryView> {
    let at = |position: u64| {
        Cursor {
            turn: turn_index,
            position,
        }
        .render()
    };
    let mut out = Vec::new();
    if let Some(prompt) = prompt.map(str::trim).filter(|p| !p.is_empty()) {
        out.push(EntryView {
            cursor: at(USER_POSITION),
            turn: turn.to_string(),
            kind: EntryKind::User,
            text: prompt.to_string(),
            tool: None,
            status: None,
        });
    }
    for (index, entry) in normalized.iter().enumerate() {
        let (kind, tool, status) = match &entry.entry_type {
            NormalizedEntryType::AssistantMessage => (EntryKind::Assistant, None, None),
            NormalizedEntryType::ToolUse {
                tool_name, status, ..
            } => (
                EntryKind::Tool,
                Some(tool_name.clone()),
                tag(status, "status"),
            ),
            NormalizedEntryType::ErrorMessage { error_type } => {
                (EntryKind::Error, None, tag(error_type, "type"))
            }
            NormalizedEntryType::UserFeedback { denied_tool } => (
                EntryKind::User,
                Some(denied_tool.clone()),
                Some("denied".into()),
            ),
            // The prompt already stands for the user's message; the rest is
            // presentation detail of the app.
            NormalizedEntryType::UserMessage
            | NormalizedEntryType::SystemMessage
            | NormalizedEntryType::Thinking
            | NormalizedEntryType::Loading
            | NormalizedEntryType::NextAction { .. } => continue,
        };
        out.push(EntryView {
            cursor: at(index as u64 + 1),
            turn: turn.to_string(),
            kind,
            text: entry.content.clone(),
            tool,
            status,
        });
    }
    if let Some(status) = finished {
        out.push(EntryView {
            cursor: at(normalized.len() as u64 + 1),
            turn: turn.to_string(),
            kind: EntryKind::TurnEnd,
            text: String::new(),
            tool: None,
            status: tag(status, "status"),
        });
    }
    out
}

fn select(entries: Vec<EntryView>, since: Option<Cursor>, limit: usize) -> Entries {
    let picked: Vec<EntryView> = entries
        .into_iter()
        .filter(|entry| match since {
            Some(since) => Cursor::parse(&entry.cursor).is_ok_and(|cursor| cursor > since),
            None => true,
        })
        .take(limit)
        .collect();
    let next_cursor = picked
        .last()
        .map(|entry| entry.cursor.clone())
        .or_else(|| since.map(Cursor::render));
    Entries {
        entries: picked,
        next_cursor,
    }
}

/// The normalized conversation of one turn, live or finished.
async fn normalized(state: &AppState, run: &TaskRun) -> Result<Vec<NormalizedEntry>, V1Error> {
    let live = state
        .runtime()
        .msg_stores()
        .read()
        .await
        .get(&run.id)
        .cloned();
    let patches: Vec<Value> = match live {
        // A live store streams forever; its history is the snapshot so far.
        Some(store) => store
            .history()
            .into_iter()
            .filter_map(|entry| match entry {
                LogEntry::JsonPatch(value) => Some(value),
                _ => None,
            })
            .collect(),
        None => {
            state
                .runtime()
                .stream_logs(run.id)
                .await?
                .filter_map(|entry| async move {
                    match entry {
                        Ok(LogEntry::JsonPatch(value)) => Some(value),
                        _ => None,
                    }
                })
                .collect()
                .await
        }
    };
    Ok(fold_patches(&patches))
}

pub(crate) async fn list(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Path(selector): Path<String>,
    Query(query): Query<EntriesQuery>,
) -> V1Result<Entries> {
    let since = query.since.as_deref().map(Cursor::parse).transpose()?;
    let limit = query.limit.map(|n| n as usize).unwrap_or(DEFAULT_LIMIT);
    let pool = state.pool();
    let task = selectors::session(pool, caller, &selector).await?;

    let mut runs = TaskRun::list_by_task_id(pool, task.id).await?;
    runs.reverse(); // oldest first
    let prompts = TaskSession::list_by_task_id(pool, task.id).await?;

    let mut all = Vec::new();
    for (index, run) in runs.iter().enumerate() {
        let index = index as u64;
        // Turns wholly before the cursor cannot contribute.
        if since.is_some_and(|since| index < since.turn) {
            continue;
        }
        let turn = run.slug.clone().unwrap_or_else(|| run.id.to_string());
        let prompt = prompts
            .iter()
            .find(|session| session.task_run_id == Some(run.id))
            .and_then(|session| session.prompt.as_deref());
        let finished = matches!(
            run.status,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled
        )
        .then_some(run.status);
        let normalized = normalized(&state, run).await?;
        all.extend(turn_entries(index, &turn, prompt, &normalized, finished));
        // Later turns only come after these; stop once the page is full.
        let unread = all
            .iter()
            .filter(|entry| match since {
                Some(since) => Cursor::parse(&entry.cursor).is_ok_and(|cursor| cursor > since),
                None => true,
            })
            .count();
        if unread >= limit {
            break;
        }
    }
    Ok(V1(select(all, since, limit)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use log_types::ConversationPatch;

    fn entry(entry_type: NormalizedEntryType, content: &str) -> NormalizedEntry {
        NormalizedEntry {
            timestamp: None,
            entry_type,
            content: content.to_string(),
            metadata: None,
        }
    }

    fn value(patch: impl serde::Serialize) -> Value {
        serde_json::to_value(patch).unwrap()
    }

    #[test]
    fn folding_follows_json_patch_array_semantics() {
        let patches = vec![
            value(ConversationPatch::add_normalized_entry(
                0,
                entry(NormalizedEntryType::AssistantMessage, "a"),
            )),
            value(ConversationPatch::add_normalized_entry(
                1,
                entry(NormalizedEntryType::AssistantMessage, "b"),
            )),
            value(ConversationPatch::replace(
                0,
                entry(NormalizedEntryType::AssistantMessage, "a2"),
            )),
            value(ConversationPatch::remove(1)),
            serde_json::json!([{ "op": "add", "path": "/approvals/x", "value": {} }]),
        ];
        let folded = fold_patches(&patches);
        assert_eq!(folded.len(), 1);
        assert_eq!(folded[0].content, "a2");
    }

    #[test]
    fn a_turn_reads_as_prompt_then_work_then_its_end() {
        let normalized = vec![
            entry(NormalizedEntryType::SystemMessage, "init"),
            entry(NormalizedEntryType::Thinking, "hmm"),
            entry(
                NormalizedEntryType::ToolUse {
                    tool_name: "Bash".into(),
                    action_type: log_types::ActionType::Other {
                        description: "ls".into(),
                    },
                    status: log_types::ToolStatus::Success,
                },
                "ls",
            ),
            entry(NormalizedEntryType::AssistantMessage, "done"),
        ];
        let entries = turn_entries(
            2,
            "t1",
            Some("do it"),
            &normalized,
            Some(RunStatus::Completed),
        );
        let kinds: Vec<_> = entries.iter().map(|e| e.kind).collect();
        assert_eq!(
            kinds,
            vec![
                EntryKind::User,
                EntryKind::Tool,
                EntryKind::Assistant,
                EntryKind::TurnEnd
            ]
        );
        assert_eq!(entries[0].cursor, "2.0");
        assert_eq!(
            entries[1].cursor, "2.3",
            "positions survive skipped entries"
        );
        assert_eq!(entries[1].tool.as_deref(), Some("Bash"));
        assert_eq!(entries[3].cursor, "2.5", "the end follows the last entry");
        assert_eq!(entries[1].status.as_deref(), Some("success"));
        assert_eq!(entries[3].status.as_deref(), Some("completed"));
    }

    #[test]
    fn since_returns_only_what_follows_without_repeats() {
        let mut all = turn_entries(
            0,
            "t0",
            Some("one"),
            &[entry(NormalizedEntryType::AssistantMessage, "r0")],
            Some(RunStatus::Completed),
        );
        all.extend(turn_entries(
            1,
            "t1",
            Some("two"),
            &[entry(NormalizedEntryType::AssistantMessage, "r1")],
            None,
        ));

        let first = select(all.clone(), None, 2);
        assert_eq!(first.entries.len(), 2);
        let rest = select(
            all.clone(),
            Some(Cursor::parse(first.next_cursor.as_deref().unwrap()).unwrap()),
            100,
        );
        let texts: Vec<_> = rest.entries.iter().map(|e| e.kind).collect();
        assert_eq!(
            texts,
            vec![EntryKind::TurnEnd, EntryKind::User, EntryKind::Assistant]
        );

        let caught_up = select(
            all,
            Some(Cursor::parse(rest.next_cursor.as_deref().unwrap()).unwrap()),
            100,
        );
        assert!(caught_up.entries.is_empty());
        assert_eq!(
            caught_up.next_cursor, rest.next_cursor,
            "cursor holds steady"
        );
    }

    #[test]
    fn malformed_cursors_are_refused() {
        assert!(Cursor::parse("x").is_err());
        assert!(Cursor::parse("1.").is_err());
        assert_eq!(
            Cursor::parse("3.7").unwrap(),
            Cursor {
                turn: 3,
                position: 7
            }
        );
    }
}
