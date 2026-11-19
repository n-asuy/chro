//! Locks the types of the `/rpc` endpoints phones may call.
//!
//! `/rpc` has no version of its own, so the device API generation stands in
//! for it. These tests catch a change that would break a phone:
//!
//! - **Responses**: each listed read answers a seeded fixture, and its JSON
//!   shape must still contain the locked shape in `testdata/rpc-schema-lock.json`
//!   (same keys, same types). New keys pass; removed keys and changed types
//!   fail.
//! - **Streams**: the phone-only session list stream's first message is
//!   locked the same way, as one item and one project's counts (its maps
//!   are keyed by ids).
//! - **Requests**: each listed write gets the body phones send, and must not
//!   refuse it as malformed (400, 415, 422). Writes aimed at a missing id
//!   must reach the id lookup (404), which runs after the body is parsed.
//!
//! After an intended change: if it breaks phones, raise
//! `dispatch::API_GENERATION`; then rewrite the lock with
//! `CHRO_UPDATE_SCHEMA_LOCK=1`.

use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
};

use axum::{
    body::Body,
    extract::Request,
    http::{header, Method, StatusCode},
};
use db::models::{TaskContextRef, TaskContextRefInput, TaskRun};
use runtime::Runtime;
use serde_json::{json, Map, Value};
use tower::ServiceExt;
use uuid::Uuid;

use super::{allowlist::ALLOWLIST, dispatch::device_router};
use crate::{operator::DeviceAdmission, routes::stream_sources::StreamSource, test_support};

const LOCK_FILE: &str = "src/mobile/testdata/rpc-schema-lock.json";
const UPDATE_ENV: &str = "CHRO_UPDATE_SCHEMA_LOCK";

/// Reads whose answers are locked, with the query each needs.
const LOCKED_READS: &[(&str, &str)] = &[
    ("/rpc/projects", ""),
    ("/rpc/session-list", ""),
    ("/rpc/projects/:project_id", ""),
    ("/rpc/projects/:project_id/sessions", ""),
    ("/rpc/projects/:project_id/active-run", ""),
    ("/rpc/projects/:project_id/entries", ""),
    ("/rpc/projects/:project_id/file", "relative_path=README.md"),
    ("/rpc/projects/:project_id/search", "q=README"),
    ("/rpc/projects/:project_id/resolve-file", "name=README.md"),
    ("/rpc/projects/:project_id/tree", ""),
    ("/rpc/projects/:project_id/media", ""),
    ("/rpc/projects/:project_id/directory-agent", ""),
    ("/rpc/projects/:project_id/git/status", ""),
    ("/rpc/projects/:project_id/git/decorated-tree", ""),
    ("/rpc/projects/:project_id/git/branches", ""),
    ("/rpc/projects/:project_id/git/branch", ""),
    ("/rpc/projects/:project_id/git/diff", ""),
    ("/rpc/tasks/:id/last-message", ""),
    ("/rpc/tasks/:id/exchanges", ""),
    ("/rpc/tasks/:id/pending-question", ""),
    ("/rpc/tasks/:id/context-refs", ""),
    ("/rpc/tasks/:id/referenced-by", ""),
    ("/rpc/tasks/:id/runs", ""),
    ("/rpc/tasks/:id/transcript", ""),
    ("/rpc/tasks/:id/images", ""),
    ("/rpc/tasks/:task_id/merges", ""),
    ("/rpc/task-runs/:id/with-task", ""),
    ("/rpc/task-runs/:id/entries", ""),
    ("/rpc/task-runs/:id/file", "relative_path=README.md"),
    ("/rpc/task-runs/:id/resolve-file", "name=README.md"),
    ("/rpc/task-runs/:id/media", ""),
    ("/rpc/task-runs/:id/git/status", ""),
    ("/rpc/task-runs/:id/git/decorated-tree", ""),
    ("/rpc/task-runs/:id/git/branches", ""),
    ("/rpc/task-runs/:id/git/branch", ""),
    ("/rpc/task-runs/:id/git/diff", ""),
    ("/rpc/approvals", ""),
    ("/rpc/preferences", ""),
    ("/rpc/preferences/editor", ""),
    ("/rpc/preferences/merge", ""),
    ("/rpc/preferences/appearance", ""),
    ("/rpc/ui-state", ""),
    ("/rpc/mcp-config", "executor=CLAUDE_CODE"),
    ("/rpc/executor/profile", ""),
    ("/rpc/flags/registry", ""),
];

/// Reads not locked here, and why.
const UNLOCKED_READS: &[(&str, &str)] = &[
    ("/rpc/projects/:project_id/binary-file", "raw bytes"),
    (
        "/rpc/projects/:project_id/asset/*relative_path",
        "raw bytes",
    ),
    ("/rpc/task-runs/:id/binary-file", "raw bytes"),
    ("/rpc/task-runs/:id/asset/*relative_path", "raw bytes"),
    ("/rpc/images/:id/file", "raw bytes"),
    ("/rpc/images/metadata", "reads a host path's image metadata"),
    (
        "/rpc/cli-status",
        "depends on the agent CLIs installed on the host",
    ),
    ("/rpc/agent-usage", "asks the agent vendor's usage endpoint"),
    (
        "/rpc/executor/install-status",
        "depends on the host's installs",
    ),
    (
        "/rpc/executor/pi/models",
        "depends on the host's agent credentials",
    ),
    ("/rpc/executor/mcp-status", "runs the agent CLI on the host"),
    ("/rpc/filesystem/directory", "lists a folder on the host"),
    ("/rpc/skills", "depends on the host's skill folders"),
    (
        "/rpc/approvals/:id",
        "needs a live agent waiting on an approval",
    ),
    (
        "/rpc/tasks/:id/exchanges/:session_id",
        "needs a finished agent turn",
    ),
    (
        "/rpc/task-runs/by-session/:session_id",
        "needs a finished agent turn",
    ),
    (
        "/rpc/task-runs/:id/branch-status",
        "needs a run worktree on its own branch",
    ),
    (
        "/rpc/task-runs/:id/branches",
        "needs a run worktree on its own branch",
    ),
    (
        "/rpc/tasks/:id/diff",
        "needs a run worktree on its own branch",
    ),
];

/// The phone-only stream whose snapshot is locked.
const SESSION_LIST_STREAM: &str = "/streams/session-list";

/// The session list snapshot as `{tasks: <one item>, counts: <one project>}`.
async fn session_list_shape(state: &crate::AppState) -> Value {
    use futures::StreamExt;

    let source = StreamSource::resolve(state, SESSION_LIST_STREAM, &HashMap::new())
        .await
        .unwrap()
        .expect("the session list stream");
    let first = source.open(state.clone()).next().await.expect("a snapshot");
    let message: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(message["type"], "json_patch", "{message}");
    let mut locked = Map::new();
    for operation in message["payload"].as_array().expect("a patch") {
        let member = operation["path"]
            .as_str()
            .unwrap()
            .trim_start_matches('/')
            .to_string();
        let first_value = operation["value"]
            .as_object()
            .and_then(|map| map.values().next())
            .unwrap_or_else(|| panic!("the fixture must fill {member}: {operation}"));
        locked.insert(member, shape(first_value));
    }
    Value::Object(locked)
}

/// What a write aimed at the fixture should answer.
#[derive(Clone, Copy)]
enum Expect {
    /// Aimed at a missing id: the body parsed, then the lookup failed.
    Missing,
    /// Applied to the fixture's settings.
    Applied,
}

/// Writes and the bodies phones send.
fn locked_writes() -> Vec<(Method, &'static str, Option<Value>, Expect)> {
    use Expect::*;
    let paths = || json!({"paths": ["a.txt"]});
    vec![
        (Method::POST, "/rpc/projects/general", None, Applied),
        (
            Method::POST,
            "/rpc/projects/:project_id/badge-color",
            Some(json!({"badge_color": "#ff0000"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/probe-paths",
            Some(json!({"paths": []})),
            Missing,
        ),
        (
            Method::PUT,
            "/rpc/projects/:project_id/file",
            Some(json!({"relative_path": "a.txt", "content": "x"})),
            Missing,
        ),
        (
            Method::DELETE,
            "/rpc/projects/:project_id/file",
            None,
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/directory",
            Some(json!({"relative_path": "notes"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/rename",
            Some(json!({"old_relative_path": "a.txt", "new_relative_path": "b.txt"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/copy",
            Some(json!({"source_relative_path": "a.txt", "dest_relative_path": "b.txt"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/ensure",
            Some(json!({"git_repo_path": "/tmp/chro-phone-project"})),
            Applied,
        ),
        (
            Method::PATCH,
            "/rpc/tasks/:id/status",
            Some(json!({"status": "pending"})),
            Missing,
        ),
        (
            Method::PATCH,
            "/rpc/tasks/:id/title",
            Some(json!({"title": "Renamed"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/tasks/:id/fork",
            Some(json!({"workspace": "same"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/tasks/:id/probe-paths",
            Some(json!({"paths": []})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/tasks/:id/delegate",
            Some(json!({"prompt": "Do the next step"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/tasks/:id/messages",
            Some(json!({
                "prompt": "hi",
                "mode": "auto",
                "executor_profile_id": {"executor": "CLAUDE_CODE"},
                "image_ids": [Uuid::nil()],
                "selected_skill_ids": [],
                "context_refs": [],
            })),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/tasks/:id/queue",
            Some(json!({"prompt": "next"})),
            Missing,
        ),
        (
            Method::PUT,
            "/rpc/tasks/:id/queue",
            Some(json!({"item_ids": [Uuid::nil()]})),
            Missing,
        ),
        (
            Method::PATCH,
            "/rpc/tasks/:id/queue/:item_id",
            Some(json!({"prompt": "edited"})),
            Missing,
        ),
        (
            Method::DELETE,
            "/rpc/tasks/:id/queue/:item_id",
            None,
            Missing,
        ),
        (
            Method::POST,
            "/rpc/tasks/:id/queue/:item_id/send",
            None,
            Missing,
        ),
        (Method::POST, "/rpc/tasks/:id/cancel", None, Missing),
        (
            Method::POST,
            "/rpc/tasks/:id/merge",
            Some(json!({"commit_message": "msg"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/tasks/:id/rebase",
            Some(json!({"new_base_branch": "main"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/fork",
            Some(json!({})),
            Missing,
        ),
        (Method::POST, "/rpc/task-runs/:id/cancel", None, Missing),
        (
            Method::POST,
            "/rpc/task-runs/:id/probe-paths",
            Some(json!({"paths": []})),
            Missing,
        ),
        (
            Method::PUT,
            "/rpc/task-runs/:id/file",
            Some(json!({"relative_path": "a.txt", "content": "x"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/merge",
            Some(json!({})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/rebase",
            Some(json!({"new_base_branch": "main"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/conflicts/abort",
            None,
            Missing,
        ),
        (Method::DELETE, "/rpc/images/:id", None, Missing),
        (
            Method::POST,
            "/rpc/approvals/:id/respond",
            Some(json!({"status": {"status": "denied", "reason": "no"}})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/cbase/query",
            Some(
                json!({"content": "version: 1\nname: T\ndataset:\n  include: [\"**/*.md\"]\nproperties: {}\nviews: []\n"}),
            ),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/cbase/persist",
            Some(json!({
                "basePath": "t.cbase",
                "definition": {"version": 1, "name": "T", "dataset": {"include": ["**/*.md"]}, "properties": {}, "views": []},
                "properties": {},
            })),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/cbase/set-property",
            Some(json!({"filePath": "row.md", "key": "status", "value": "done"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/git/stage",
            Some(paths()),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/git/unstage",
            Some(paths()),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/git/discard-files",
            Some(paths()),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/git/commit",
            Some(json!({"message": "msg"})),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/git/push",
            None,
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/git/pull",
            None,
            Missing,
        ),
        (
            Method::POST,
            "/rpc/projects/:project_id/git/discard",
            None,
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/git/stage",
            Some(paths()),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/git/unstage",
            Some(paths()),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/git/discard-files",
            Some(paths()),
            Missing,
        ),
        (
            Method::POST,
            "/rpc/task-runs/:id/git/commit",
            Some(json!({"message": "msg"})),
            Missing,
        ),
        (Method::POST, "/rpc/task-runs/:id/git/push", None, Missing),
        (Method::POST, "/rpc/task-runs/:id/git/pull", None, Missing),
        (
            Method::POST,
            "/rpc/task-runs/:id/git/discard",
            None,
            Missing,
        ),
        (
            Method::PUT,
            "/rpc/preferences",
            Some(json!({"language": "en", "show_hidden_entries": false})),
            Applied,
        ),
        (
            Method::PUT,
            "/rpc/preferences/editor",
            Some(
                json!({"font_family": null, "line_height": 1.5, "show_line_numbers": true, "line_wrapping": true, "indent_with_spaces": true, "tab_size": 2, "vim_mode": false}),
            ),
            Applied,
        ),
        (
            Method::PUT,
            "/rpc/preferences/merge",
            Some(json!({"merge_commit_template": "{{title}}"})),
            Applied,
        ),
        (
            Method::PUT,
            "/rpc/executor/profile",
            Some(json!({"executor": "CLAUDE_CODE"})),
            Applied,
        ),
        (
            Method::PUT,
            "/rpc/preferences/appearance",
            Some(json!({"accent": "#7c3aed"})),
            Applied,
        ),
        (
            Method::PUT,
            "/rpc/ui-state",
            Some(json!({"chro.recentWorkspaces": ["/tmp/repo"]})),
            Applied,
        ),
        (
            Method::PUT,
            "/rpc/mcp-config",
            Some(json!({"servers": {}, "executor": "CLAUDE_CODE"})),
            Applied,
        ),
    ]
}

/// Queries some writes need besides their body, as phones send them.
const WRITE_QUERIES: &[(&str, &str, &str)] = &[
    (
        "DELETE",
        "/rpc/projects/:project_id/file",
        "relative_path=a.txt",
    ),
    ("PUT", "/rpc/mcp-config", "executor=CLAUDE_CODE"),
];

fn write_query(method: &Method, template: &str) -> Option<&'static str> {
    WRITE_QUERIES
        .iter()
        .find(|(m, t, _)| *m == method.as_str() && *t == template)
        .map(|(_, _, query)| *query)
}

/// Writes that take a multipart upload; the dispatcher's upload test covers
/// the encoding, and the image endpoints keep the `image` field.
const MULTIPART_WRITES: &[&str] = &[
    "/rpc/images/upload",
    "/rpc/tasks/:id/images/upload",
    "/rpc/task-runs/:id/images/upload",
];

fn fill(template: &str, ids: &BTreeMap<&str, String>) -> String {
    let mut segments: Vec<String> = Vec::new();
    for segment in template.split('/') {
        let filled = match segment.strip_prefix(':') {
            Some(name) => {
                // `:id` means the task under /tasks and the run under /task-runs.
                let key = match (name, segments.last().map(String::as_str)) {
                    ("id", Some("tasks")) => "task",
                    ("id", Some("task-runs")) => "run",
                    ("id", _) => "other",
                    (name, _) => name,
                };
                ids.get(key)
                    .unwrap_or_else(|| panic!("no fixture id for {name} in {template}"))
                    .clone()
            }
            None => segment.to_string(),
        };
        segments.push(filled);
    }
    segments.join("/")
}

async fn call(
    router: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<&Value>,
) -> (StatusCode, Vec<u8>) {
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header(header::CONTENT_TYPE, "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let mut request = request.body(body).unwrap();
    request.extensions_mut().insert(DeviceAdmission {
        device_id: Uuid::new_v4(),
    });
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, bytes.to_vec())
}

/// The JSON shape of a value: types instead of values, element shapes merged.
fn shape(value: &Value) -> Value {
    match value {
        Value::Null => json!("null"),
        Value::Bool(_) => json!("boolean"),
        Value::Number(_) => json!("number"),
        Value::String(_) => json!("string"),
        Value::Array(items) => {
            let merged = items.iter().map(shape).reduce(merge);
            json!([merged.unwrap_or(json!("unknown"))])
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), shape(value)))
                .collect(),
        ),
    }
}

fn merge(a: Value, b: Value) -> Value {
    match (a, b) {
        (a, b) if a == b => a,
        (Value::Object(mut a), Value::Object(b)) => {
            for (key, value) in b {
                let merged = match a.remove(&key) {
                    Some(existing) => merge(existing, value),
                    None => value,
                };
                a.insert(key, merged);
            }
            Value::Object(a)
        }
        (Value::Array(a), Value::Array(b)) => {
            json!([merge(a[0].clone(), b[0].clone())])
        }
        (a, b) => {
            let mut options: Vec<Value> = Vec::new();
            for value in [a, b] {
                match value {
                    Value::Object(map) if map.contains_key("anyOf") => {
                        options.extend(map["anyOf"].as_array().unwrap().iter().cloned())
                    }
                    other => options.push(other),
                }
            }
            options.dedup();
            json!({ "anyOf": options })
        }
    }
}

/// Where `actual` breaks `locked`: a missing key or a different type. Keys
/// `actual` adds are compatible.
fn breaks(locked: &Value, actual: &Value, at: &str, out: &mut Vec<String>) {
    match (locked, actual) {
        (Value::Object(locked_map), Value::Object(actual_map))
            if !locked_map.contains_key("anyOf") =>
        {
            for (key, locked_value) in locked_map {
                match actual_map.get(key) {
                    Some(actual_value) => {
                        breaks(locked_value, actual_value, &format!("{at}.{key}"), out)
                    }
                    None => out.push(format!("{at}.{key} was removed")),
                }
            }
        }
        (Value::Array(locked_items), Value::Array(actual_items)) => {
            // An empty array in the fixture locks nothing about its elements.
            if actual_items[0] != json!("unknown") && locked_items[0] != json!("unknown") {
                breaks(&locked_items[0], &actual_items[0], &format!("{at}[]"), out);
            }
        }
        (locked, actual) if locked == actual => {}
        // The fixture had no value here; the lock only holds the key.
        (Value::String(locked), _) if locked == "null" => {}
        (locked, actual) => out.push(format!("{at} changed from {locked} to {actual}")),
    }
}

#[tokio::test]
async fn every_listed_rpc_endpoint_is_locked_or_explained() {
    let reads: Vec<&str> = LOCKED_READS
        .iter()
        .map(|(template, _)| *template)
        .chain(UNLOCKED_READS.iter().map(|(template, _)| *template))
        .collect();
    let writes: Vec<(Method, &str)> = locked_writes()
        .into_iter()
        .map(|(method, template, _, _)| (method, template))
        .collect();
    for entry in ALLOWLIST
        .iter()
        .filter(|entry| entry.template.starts_with("/rpc/"))
    {
        if entry.method == Method::GET {
            assert!(
                reads.contains(&entry.template),
                "GET {} is listed for phones but neither locked nor explained",
                entry.template
            );
        } else {
            assert!(
                writes.contains(&(entry.method.clone(), entry.template))
                    || (entry.method == Method::POST && MULTIPART_WRITES.contains(&entry.template)),
                "{} {} is listed for phones but its request is not locked",
                entry.method,
                entry.template
            );
        }
    }
}

#[tokio::test]
async fn listed_rpc_responses_keep_their_locked_shapes() {
    let _agent_config = test_support::agent_config_lock().await;
    let app = test_support::app().await;
    let project = app.project("repo").await;
    let task = app.task(&project, "Locked session").await;
    let referenced = app.task(&project, "Referenced session").await;
    // Non-empty lists wherever the fixture can provide them, so element
    // shapes are locked too: a referenced session, an attached image, an
    // edited and an untracked file, a media file.
    TaskContextRef::insert_for_task(
        app.pool(),
        task.id,
        None,
        None,
        &TaskContextRefInput::session(referenced.id, None),
        0,
    )
    .await
    .unwrap();
    app.state
        .runtime()
        .image()
        .store_and_link_task(b"fixture image", "shelf.png", task.id)
        .await
        .unwrap();
    let repo = std::path::Path::new(&project.git_repo_path);
    std::fs::write(repo.join("README.md"), "# fixture\n\nEdited.\n").unwrap();
    std::fs::write(repo.join("notes.md"), "untracked\n").unwrap();
    std::fs::write(repo.join("shelf.png"), b"fixture image").unwrap();
    let mut run = TaskRun::new_local(task.id, None);
    run.workspace_path = Some(project.git_repo_path.clone());
    run.container_ref = Some(project.git_repo_path.clone());
    run.branch_name = Some("main".into());
    run.target_branch = Some("main".into());
    run.insert(app.pool()).await.unwrap();
    let ids = BTreeMap::from([
        ("project_id", project.id.to_string()),
        ("task_id", task.id.to_string()),
        ("task", task.id.to_string()),
        ("run", run.id.to_string()),
    ]);
    let router = device_router(app.state.clone());

    let mut actual = Map::new();
    let mut failures = Vec::new();
    for (template, query) in LOCKED_READS {
        let mut uri = fill(template, &ids);
        if !query.is_empty() {
            uri = format!("{uri}?{query}");
        }
        let (status, bytes) = call(&router, Method::GET, &uri, None).await;
        if !status.is_success() {
            failures.push(format!(
                "GET {template} answered {status}: {}",
                String::from_utf8_lossy(&bytes)
            ));
            continue;
        }
        let body: Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|err| panic!("GET {template} is not JSON: {err}"));
        actual.insert(format!("GET {template}"), shape(&body));
    }
    assert!(
        failures.is_empty(),
        "the fixture must answer every locked read:\n{}",
        failures.join("\n")
    );
    actual.insert(
        format!("SUBSCRIBE {SESSION_LIST_STREAM}"),
        session_list_shape(&app.state).await,
    );

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(LOCK_FILE);
    if std::env::var_os(UPDATE_ENV).is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let text = serde_json::to_string_pretty(&Value::Object(actual)).unwrap();
        std::fs::write(&path, text + "\n").unwrap();
        return;
    }
    let locked: Map<String, Value> = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|_| panic!("{} is missing; run with {UPDATE_ENV}=1", path.display())),
    )
    .unwrap();
    let mut broken = Vec::new();
    for (endpoint, locked_shape) in &locked {
        match actual.get(endpoint) {
            Some(actual_shape) => breaks(locked_shape, actual_shape, endpoint, &mut broken),
            None => broken.push(format!("{endpoint} is no longer locked")),
        }
    }
    for endpoint in actual.keys() {
        assert!(
            locked.contains_key(endpoint),
            "{endpoint} is not in the lock yet; run with {UPDATE_ENV}=1"
        );
    }
    assert!(
        broken.is_empty(),
        "phone-visible /rpc responses changed incompatibly:\n{}\n\nIf this is intended, raise API_GENERATION and rewrite the lock with {UPDATE_ENV}=1.",
        broken.join("\n")
    );
}

#[tokio::test]
async fn listed_rpc_writes_accept_the_bodies_phones_send() {
    let _agent_config = test_support::agent_config_lock().await;
    let app = test_support::app().await;
    let router = device_router(app.state.clone());
    let missing = Uuid::new_v4().to_string();
    let ids = BTreeMap::from([
        ("project_id", missing.clone()),
        ("task_id", missing.clone()),
        ("task", missing.clone()),
        ("run", missing.clone()),
        ("item_id", Uuid::new_v4().to_string()),
        ("other", missing.clone()),
    ]);
    let mut failures = Vec::new();
    for (method, template, body, expect) in locked_writes() {
        let mut uri = fill(template, &ids);
        if let Some(query) = write_query(&method, template) {
            uri = format!("{uri}?{query}");
        }
        let (status, bytes) = call(&router, method.clone(), &uri, body.as_ref()).await;
        let ok = match expect {
            Expect::Missing => status == StatusCode::NOT_FOUND,
            Expect::Applied => status.is_success(),
        };
        if !ok {
            failures.push(format!(
                "{method} {template} answered {status}: {}",
                String::from_utf8_lossy(&bytes)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn shapes_merge_elements_and_flag_only_breaking_changes() {
    let locked = shape(&json!({"a": 1, "list": [{"x": "s"}, {"x": "t", "y": null}]}));
    assert_eq!(
        locked,
        json!({"a": "number", "list": [{"x": "string", "y": "null"}]})
    );

    let mut out = Vec::new();
    let added = shape(&json!({"a": 2, "b": true, "list": [{"x": "u", "y": null, "z": 1}]}));
    breaks(&locked, &added, "GET /x", &mut out);
    assert!(out.is_empty(), "additions are compatible: {out:?}");

    let mut out = Vec::new();
    let broken = shape(&json!({"a": "2", "list": [{"y": null}]}));
    breaks(&locked, &broken, "GET /x", &mut out);
    assert_eq!(
        out,
        vec![
            "GET /x.a changed from \"number\" to \"string\"".to_string(),
            "GET /x.list[].x was removed".to_string(),
        ]
    );
}
