use std::collections::HashSet;

use db::models::TaskContextRefInput;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use sqlx::{Pool, Sqlite};

use crate::{identifiers::resolve_task_id, ApiError};

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ContextRefRequest {
    pub kind: String,
    pub task_id: Option<String>,
    pub target_task_id: Option<String>,
    pub session_id: Option<String>,
    pub target_session_id: Option<String>,
    pub path: Option<String>,
    pub branch: Option<String>,
    pub mode: Option<String>,
    pub label: Option<String>,
    pub metadata: Option<JsonValue>,
}

pub(super) async fn resolve_context_refs(
    pool: &Pool<Sqlite>,
    prompt: &str,
    explicit_refs: &[ContextRefRequest],
) -> Result<Vec<TaskContextRefInput>, ApiError> {
    let mut refs = Vec::new();

    for context_ref in explicit_refs {
        refs.push(resolve_context_ref(pool, context_ref, true).await?);
    }

    for parsed in parse_prompt_context_refs(prompt) {
        if let Ok(context_ref) = resolve_context_ref(pool, &parsed, false).await {
            refs.push(context_ref);
        }
    }

    Ok(dedupe_refs(refs))
}

async fn resolve_context_ref(
    pool: &Pool<Sqlite>,
    input: &ContextRefRequest,
    strict: bool,
) -> Result<TaskContextRefInput, ApiError> {
    let kind = input.kind.trim().to_ascii_lowercase();
    if !matches!(
        kind.as_str(),
        "session" | "task" | "file" | "directory" | "skill" | "image"
    ) {
        return Err(ApiError::BadRequest(format!(
            "unsupported context ref kind: {}",
            input.kind
        )));
    }

    let task_identifier = input
        .target_task_id
        .as_deref()
        .or(input.task_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_task_id = match task_identifier {
        Some(identifier) => Some(resolve_task_id(pool, identifier).await?),
        None => None,
    };

    if strict && matches!(kind.as_str(), "session" | "task") && target_task_id.is_none() {
        return Err(ApiError::BadRequest(format!(
            "{} context ref requires task_id",
            kind
        )));
    }

    let session_identifier = input
        .target_session_id
        .as_deref()
        .or(input.session_id.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_session_id = match session_identifier {
        Some(identifier) => Some(identifier.parse()?),
        None => None,
    };

    let path = normalize_optional_string(input.path.clone());
    if strict && matches!(kind.as_str(), "file" | "directory") && path.is_none() {
        return Err(ApiError::BadRequest(format!(
            "{} context ref requires path",
            kind
        )));
    }

    let metadata_json =
        match input.metadata.as_ref() {
            Some(value) => Some(serde_json::to_string(value).map_err(|err| {
                ApiError::BadRequest(format!("invalid context ref metadata: {err}"))
            })?),
            None => None,
        };

    Ok(TaskContextRefInput {
        kind: kind.clone(),
        target_task_id,
        target_session_id,
        path,
        branch: normalize_optional_string(input.branch.clone()),
        mode: normalize_optional_string(input.mode.clone()).or_else(|| {
            Some(if kind == "session" {
                "transcript".to_string()
            } else {
                "link".to_string()
            })
        }),
        label: normalize_optional_string(input.label.clone()),
        metadata_json,
    })
}

fn dedupe_refs(refs: Vec<TaskContextRefInput>) -> Vec<TaskContextRefInput> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(refs.len());
    for context_ref in refs {
        let key = format!(
            "{}|{:?}|{:?}|{}|{}|{}",
            context_ref.kind,
            context_ref.target_task_id,
            context_ref.target_session_id,
            context_ref.path.as_deref().unwrap_or_default(),
            context_ref.branch.as_deref().unwrap_or_default(),
            context_ref.mode.as_deref().unwrap_or_default(),
        );
        if seen.insert(key) {
            deduped.push(context_ref);
        }
    }
    deduped
}

fn parse_prompt_context_refs(prompt: &str) -> Vec<ContextRefRequest> {
    let mut refs = Vec::new();
    refs.extend(parse_tags(prompt, "<past_session", |tag| {
        extract_attr(tag, "task_id").map(|task_id| ContextRefRequest {
            kind: "session".to_string(),
            task_id: Some(task_id),
            target_task_id: None,
            session_id: None,
            target_session_id: None,
            path: None,
            branch: extract_attr(tag, "branch"),
            mode: Some("transcript".to_string()),
            label: None,
            metadata: None,
        })
    }));
    refs.extend(parse_tags(prompt, "<file", |tag| {
        extract_attr(tag, "path").map(|path| ContextRefRequest {
            kind: "file".to_string(),
            task_id: None,
            target_task_id: None,
            session_id: None,
            target_session_id: None,
            path: Some(path),
            branch: extract_attr(tag, "branch"),
            mode: Some("link".to_string()),
            label: None,
            metadata: None,
        })
    }));
    refs.extend(parse_tags(prompt, "<directory", |tag| {
        extract_attr(tag, "path").map(|path| ContextRefRequest {
            kind: "directory".to_string(),
            task_id: None,
            target_task_id: None,
            session_id: None,
            target_session_id: None,
            path: Some(path),
            branch: extract_attr(tag, "branch"),
            mode: Some("link".to_string()),
            label: None,
            metadata: None,
        })
    }));
    refs
}

fn parse_tags<F>(prompt: &str, needle: &str, mut parse: F) -> Vec<ContextRefRequest>
where
    F: FnMut(&str) -> Option<ContextRefRequest>,
{
    let mut refs = Vec::new();
    let mut offset = 0;
    while let Some(relative_start) = prompt[offset..].find(needle) {
        let start = offset + relative_start;
        let Some(relative_end) = prompt[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        if let Some(context_ref) = parse(&prompt[start..end]) {
            refs.push(context_ref);
        }
        offset = end;
    }
    refs
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=\"");
    let start = tag.find(&needle)? + needle.len();
    let end = tag[start..].find('"')? + start;
    Some(unescape_xml_attr(&tag[start..end]))
}

fn unescape_xml_attr(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_prompt_context_tags() {
        let refs = parse_prompt_context_refs(
            "<context>\n<past_session task_id=\"abc123\" branch=\"feature/x\">\nRun logs\n</past_session>\n<file path=\"src/main.ts\" />\n<directory path=\"src/lib\" branch=\"main\" />\n</context>\nfix",
        );

        assert_eq!(refs.len(), 3);
        assert_eq!(refs[0].kind, "session");
        assert_eq!(refs[0].task_id.as_deref(), Some("abc123"));
        assert_eq!(refs[0].branch.as_deref(), Some("feature/x"));
        assert_eq!(refs[1].kind, "file");
        assert_eq!(refs[1].path.as_deref(), Some("src/main.ts"));
        assert_eq!(refs[2].kind, "directory");
    }
}
