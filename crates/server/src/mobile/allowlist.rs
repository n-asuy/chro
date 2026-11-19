//! The endpoints a paired phone may call, as `(method, route template)`.
//!
//! Templates are spelled exactly as the router mounts them, because the
//! check runs inside the router against the matched route
//! ([`axum::extract::MatchedPath`]): a request is admitted only when the
//! handler that would answer it is listed here. No separate path matcher can
//! disagree with routing.
//!
//! The list covers what the phone's screens need and nothing else. Never
//! listed: developer and maintenance tools (`/rpc/developer/*`,
//! `/rpc/dev-events`), raw execution control (`/rpc/executions/*`, run status
//! and git bookkeeping patches), the app event bus (`/rpc/events*`), the
//! interactive browser (`/streams/browser`), host filesystem browsing
//! (`/rpc/filesystem/*`, absolute paths, reveal-in-Finder), secrets
//! (`/rpc/executor/pi/api-key`), agent launch arguments (arbitrary CLI flags
//! for processes on the host: `/rpc/executor/launch-settings`), and the pairing
//! API itself (`/rpc/mobile/*`).
//!
//! Adding an entry is compatible and does not change the API generation;
//! removing one or changing a listed endpoint's types is a breaking change
//! (see `schema_lock`).

use axum::http::Method;

/// The phone screen family an endpoint serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Surface {
    /// Session list: projects, sections, rows, row menus.
    Sessions,
    /// A session's conversation, runs, history and relations.
    Conversation,
    /// The composer: send, queue, attachments, refs, runtime options.
    Composer,
    /// Questions and approvals raised by a running agent.
    Approvals,
    /// Files and Search in the right-dock sheet, file detail.
    Files,
    /// Source Control: status, staging, commit, push/pull, merge/rebase.
    SourceControl,
    /// The editor and structured views of an opened file.
    Editor,
    /// Images and media of a project or run.
    Gallery,
    /// The Agent dock (directory agent) and skills.
    Agent,
    /// Shared settings.
    Settings,
    /// Agent CLI status, usage meter and feature flags.
    System,
}

pub(crate) struct Allowed {
    pub method: Method,
    pub template: &'static str,
    /// The screen family that needs the endpoint. Only the coverage tests
    /// read it; it keeps the table reviewable by screen.
    #[cfg_attr(not(test), allow(dead_code))]
    pub surface: Surface,
}

const fn allow(method: Method, template: &'static str, surface: Surface) -> Allowed {
    Allowed {
        method,
        template,
        surface,
    }
}

use Surface::*;

const GET: Method = Method::GET;
const POST: Method = Method::POST;
const PUT: Method = Method::PUT;
const PATCH: Method = Method::PATCH;
const DELETE: Method = Method::DELETE;

pub(crate) const ALLOWLIST: &[Allowed] = &[
    // Operator API: everything but registering a project folder, which the
    // phone does through the desktop's own route (`/rpc/projects/ensure`).
    allow(GET, "/v1/status", System),
    allow(GET, "/v1/projects", Sessions),
    allow(GET, "/v1/projects/:project", Sessions),
    allow(GET, "/v1/sessions", Sessions),
    allow(POST, "/v1/sessions", Composer),
    allow(GET, "/v1/sessions/:session", Conversation),
    allow(PATCH, "/v1/sessions/:session", Sessions),
    allow(POST, "/v1/sessions/:session/delegations", Conversation),
    allow(POST, "/v1/sessions/:session/forks", Sessions),
    allow(POST, "/v1/sessions/:session/messages", Composer),
    allow(GET, "/v1/sessions/:session/wait", Conversation),
    allow(GET, "/v1/sessions/:session/entries", Conversation),
    allow(GET, "/v1/sessions/:session/transcript", Conversation),
    allow(POST, "/v1/sessions/:session/cancel", Composer),
    allow(DELETE, "/v1/sessions/:session/queue/:message", Composer),
    allow(GET, "/v1/sessions/:session/refs", Conversation),
    allow(GET, "/v1/sessions/:session/diff", SourceControl),
    allow(POST, "/v1/sessions/:session/merge", SourceControl),
    allow(POST, "/v1/sessions/:session/rebase", SourceControl),
    allow(GET, "/v1/approvals", Approvals),
    allow(GET, "/v1/approvals/:approval", Approvals),
    allow(POST, "/v1/approvals/:approval/respond", Approvals),
    // Session list.
    allow(GET, "/rpc/projects", Sessions),
    // The phone's own session list lookups (paging, search, archive); its
    // window streams on `/streams/session-list`.
    allow(GET, "/rpc/session-list", Sessions),
    allow(GET, "/rpc/projects/:project_id", Sessions),
    allow(POST, "/rpc/projects/general", Sessions),
    allow(POST, "/rpc/projects/:project_id/badge-color", Sessions),
    allow(GET, "/rpc/projects/:project_id/sessions", Sessions),
    allow(GET, "/rpc/projects/:project_id/active-run", Sessions),
    allow(PATCH, "/rpc/tasks/:id/status", Sessions),
    allow(PATCH, "/rpc/tasks/:id/title", Sessions),
    allow(POST, "/rpc/tasks/:id/fork", Sessions),
    allow(GET, "/rpc/tasks/:id/last-message", Sessions),
    // Shared UI state: pins, read marks, order, collapsed groups, open
    // project tabs, recent folders, onboarding completion.
    allow(GET, "/rpc/ui-state", Sessions),
    allow(PUT, "/rpc/ui-state", Sessions),
    // Opening a folder as a project. Listing folders is the only host
    // filesystem route a phone may call; a paired device can already start
    // an agent with a shell on the host, so names grant nothing more.
    allow(GET, "/rpc/filesystem/directory", Sessions),
    allow(POST, "/rpc/projects/ensure", Sessions),
    // Conversation.
    allow(GET, "/rpc/tasks/:id/exchanges", Conversation),
    allow(GET, "/rpc/tasks/:id/exchanges/:session_id", Conversation),
    allow(GET, "/rpc/tasks/:id/pending-question", Conversation),
    allow(GET, "/rpc/tasks/:id/context-refs", Conversation),
    allow(GET, "/rpc/tasks/:id/referenced-by", Conversation),
    allow(GET, "/rpc/tasks/:id/runs", Conversation),
    allow(GET, "/rpc/tasks/:id/transcript", Conversation),
    allow(POST, "/rpc/tasks/:id/probe-paths", Conversation),
    allow(GET, "/rpc/task-runs/:id/with-task", Conversation),
    allow(GET, "/rpc/task-runs/by-session/:session_id", Conversation),
    allow(POST, "/rpc/task-runs/:id/fork", Conversation),
    allow(POST, "/rpc/tasks/:id/delegate", Conversation),
    // Composer.
    allow(POST, "/rpc/tasks/:id/messages", Composer),
    allow(POST, "/rpc/tasks/:id/queue", Composer),
    allow(PUT, "/rpc/tasks/:id/queue", Composer),
    allow(PATCH, "/rpc/tasks/:id/queue/:item_id", Composer),
    allow(DELETE, "/rpc/tasks/:id/queue/:item_id", Composer),
    allow(POST, "/rpc/tasks/:id/queue/:item_id/send", Composer),
    allow(POST, "/rpc/tasks/:id/cancel", Composer),
    allow(POST, "/rpc/task-runs/:id/cancel", Composer),
    allow(POST, "/rpc/images/upload", Composer),
    allow(POST, "/rpc/tasks/:id/images/upload", Composer),
    allow(POST, "/rpc/task-runs/:id/images/upload", Composer),
    allow(GET, "/rpc/images/metadata", Composer),
    allow(GET, "/rpc/images/:id/file", Composer),
    allow(DELETE, "/rpc/images/:id", Composer),
    allow(GET, "/rpc/tasks/:id/images", Composer),
    allow(GET, "/rpc/skills", Composer),
    allow(GET, "/rpc/executor/profile", Composer),
    allow(GET, "/rpc/executor/pi/models", Composer),
    // Approvals and questions.
    allow(GET, "/rpc/approvals", Approvals),
    allow(GET, "/rpc/approvals/:id", Approvals),
    allow(POST, "/rpc/approvals/:id/respond", Approvals),
    // Files and Search, for the project and for a run's worktree.
    allow(GET, "/rpc/projects/:project_id/entries", Files),
    allow(GET, "/rpc/projects/:project_id/file", Files),
    allow(GET, "/rpc/projects/:project_id/binary-file", Files),
    allow(GET, "/rpc/projects/:project_id/asset/*relative_path", Files),
    allow(GET, "/rpc/projects/:project_id/search", Files),
    allow(GET, "/rpc/projects/:project_id/resolve-file", Files),
    allow(POST, "/rpc/projects/:project_id/probe-paths", Files),
    allow(GET, "/rpc/projects/:project_id/tree", Files),
    allow(GET, "/rpc/task-runs/:id/entries", Files),
    allow(GET, "/rpc/task-runs/:id/file", Files),
    allow(GET, "/rpc/task-runs/:id/binary-file", Files),
    allow(GET, "/rpc/task-runs/:id/asset/*relative_path", Files),
    allow(GET, "/rpc/task-runs/:id/resolve-file", Files),
    allow(POST, "/rpc/task-runs/:id/probe-paths", Files),
    // The Files panel's actions: new folder, rename or move, duplicate,
    // delete. Paths stay inside the project.
    allow(POST, "/rpc/projects/:project_id/directory", Files),
    allow(POST, "/rpc/projects/:project_id/rename", Files),
    allow(POST, "/rpc/projects/:project_id/copy", Files),
    allow(DELETE, "/rpc/projects/:project_id/file", Files),
    // Editor: saving the open file and structured views.
    allow(PUT, "/rpc/projects/:project_id/file", Editor),
    allow(PUT, "/rpc/task-runs/:id/file", Editor),
    allow(POST, "/rpc/projects/:project_id/cbase/query", Editor),
    allow(POST, "/rpc/projects/:project_id/cbase/persist", Editor),
    allow(POST, "/rpc/projects/:project_id/cbase/set-property", Editor),
    // Gallery.
    allow(GET, "/rpc/projects/:project_id/media", Gallery),
    allow(GET, "/rpc/task-runs/:id/media", Gallery),
    // Source Control, for the project and for a run's worktree.
    allow(GET, "/rpc/projects/:project_id/git/status", SourceControl),
    allow(
        GET,
        "/rpc/projects/:project_id/git/decorated-tree",
        SourceControl,
    ),
    allow(GET, "/rpc/projects/:project_id/git/branches", SourceControl),
    allow(GET, "/rpc/projects/:project_id/git/branch", SourceControl),
    allow(GET, "/rpc/projects/:project_id/git/diff", SourceControl),
    allow(POST, "/rpc/projects/:project_id/git/stage", SourceControl),
    allow(POST, "/rpc/projects/:project_id/git/unstage", SourceControl),
    allow(POST, "/rpc/projects/:project_id/git/commit", SourceControl),
    allow(POST, "/rpc/projects/:project_id/git/push", SourceControl),
    allow(POST, "/rpc/projects/:project_id/git/pull", SourceControl),
    allow(POST, "/rpc/projects/:project_id/git/discard", SourceControl),
    allow(
        POST,
        "/rpc/projects/:project_id/git/discard-files",
        SourceControl,
    ),
    allow(GET, "/rpc/task-runs/:id/git/status", SourceControl),
    allow(GET, "/rpc/task-runs/:id/git/decorated-tree", SourceControl),
    allow(GET, "/rpc/task-runs/:id/git/branches", SourceControl),
    allow(GET, "/rpc/task-runs/:id/git/branch", SourceControl),
    allow(GET, "/rpc/task-runs/:id/git/diff", SourceControl),
    allow(POST, "/rpc/task-runs/:id/git/stage", SourceControl),
    allow(POST, "/rpc/task-runs/:id/git/unstage", SourceControl),
    allow(POST, "/rpc/task-runs/:id/git/commit", SourceControl),
    allow(POST, "/rpc/task-runs/:id/git/push", SourceControl),
    allow(POST, "/rpc/task-runs/:id/git/pull", SourceControl),
    allow(POST, "/rpc/task-runs/:id/git/discard", SourceControl),
    allow(POST, "/rpc/task-runs/:id/git/discard-files", SourceControl),
    allow(GET, "/rpc/task-runs/:id/branch-status", SourceControl),
    allow(GET, "/rpc/task-runs/:id/branches", SourceControl),
    allow(GET, "/rpc/tasks/:id/diff", SourceControl),
    allow(POST, "/rpc/task-runs/:id/merge", SourceControl),
    allow(POST, "/rpc/task-runs/:id/rebase", SourceControl),
    allow(POST, "/rpc/task-runs/:id/conflicts/abort", SourceControl),
    allow(POST, "/rpc/tasks/:id/merge", SourceControl),
    allow(POST, "/rpc/tasks/:id/rebase", SourceControl),
    allow(GET, "/rpc/tasks/:task_id/merges", SourceControl),
    // Agent dock.
    allow(GET, "/rpc/projects/:project_id/directory-agent", Agent),
    // Shared settings. Theme, editor font size and notifications are kept
    // per device, on the phone.
    allow(GET, "/rpc/preferences", Settings),
    allow(PUT, "/rpc/preferences", Settings),
    allow(GET, "/rpc/preferences/editor", Settings),
    allow(PUT, "/rpc/preferences/editor", Settings),
    allow(GET, "/rpc/preferences/merge", Settings),
    allow(PUT, "/rpc/preferences/merge", Settings),
    allow(PUT, "/rpc/executor/profile", Settings),
    allow(GET, "/rpc/preferences/appearance", Settings),
    allow(PUT, "/rpc/preferences/appearance", Settings),
    allow(GET, "/rpc/mcp-config", Settings),
    allow(PUT, "/rpc/mcp-config", Settings),
    allow(GET, "/rpc/executor/mcp-status", Settings),
    // System.
    allow(GET, "/rpc/cli-status", System),
    allow(GET, "/rpc/agent-usage", System),
    allow(GET, "/rpc/executor/install-status", System),
    allow(GET, "/rpc/flags/registry", System),
];

/// Whether a device may call the route matched as `template` with `method`.
pub(crate) fn permits(method: &Method, template: &str) -> bool {
    ALLOWLIST
        .iter()
        .any(|entry| entry.method == *method && entry.template == template)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Prefixes no listed template may start with. Pi's credentials stay on
    /// the host: the phone never sees or sets the API key. Agent launch
    /// arguments put arbitrary flags on host processes, so they stay desktop-only.
    const NEVER_ALLOWED_PREFIXES: &[&str] = &[
        "/rpc/developer",
        "/rpc/dev-events",
        "/rpc/executions",
        "/rpc/events",
        "/rpc/mobile",
        "/rpc/executor/pi/api-key",
        "/rpc/executor/pi/credentials",
        "/rpc/executor/launch-settings",
        "/streams/browser",
    ];

    /// The one host filesystem route a phone may call: listing a folder to
    /// pick a project. Reading or writing arbitrary host paths, the server's
    /// working directory and workspace roots outside a project stay refused.
    const FILESYSTEM_ALLOWED: (&str, &str) = ("GET", "/rpc/filesystem/directory");

    #[test]
    fn only_the_directory_listing_is_listed_under_filesystem() {
        let listed: Vec<(String, &str)> = ALLOWLIST
            .iter()
            .filter(|entry| entry.template.starts_with("/rpc/filesystem"))
            .map(|entry| (entry.method.to_string(), entry.template))
            .collect();
        assert_eq!(
            listed,
            vec![(FILESYSTEM_ALLOWED.0.to_string(), FILESYSTEM_ALLOWED.1)]
        );
    }

    #[test]
    fn pi_credentials_and_other_host_paths_are_refused() {
        for (method, template) in [
            (Method::GET, "/rpc/executor/pi/credentials"),
            (Method::PUT, "/rpc/executor/pi/api-key"),
            (Method::DELETE, "/rpc/executor/pi/api-key"),
            (Method::GET, "/rpc/executor/launch-settings"),
            (Method::PUT, "/rpc/executor/launch-settings"),
            (Method::GET, "/rpc/filesystem/cwd"),
            (Method::GET, "/rpc/filesystem/workspace-entries"),
            (Method::GET, "/rpc/filesystem/workspace-file"),
            (Method::PUT, "/rpc/filesystem/workspace-file"),
            (Method::GET, "/rpc/filesystem/workspace-binary-file"),
            (Method::POST, "/rpc/projects/:project_id/reveal-in-finder"),
        ] {
            assert!(!permits(&method, template), "{method} {template}");
        }
    }

    /// Path suffixes no listed template may end with: host-only actions.
    const NEVER_ALLOWED_SUFFIXES: &[&str] = &["/reveal-in-finder", "/absolute-path", "/git/init"];

    #[test]
    fn entries_are_unique() {
        let mut seen = HashSet::new();
        for entry in ALLOWLIST {
            assert!(
                seen.insert((entry.method.clone(), entry.template)),
                "{} {} listed twice",
                entry.method,
                entry.template
            );
        }
    }

    #[test]
    fn admin_dev_browser_and_host_only_endpoints_are_never_listed() {
        for entry in ALLOWLIST {
            for prefix in NEVER_ALLOWED_PREFIXES {
                assert!(
                    !entry.template.starts_with(prefix),
                    "{} {} must not be callable from a phone",
                    entry.method,
                    entry.template
                );
            }
            for suffix in NEVER_ALLOWED_SUFFIXES {
                assert!(
                    !entry.template.ends_with(suffix),
                    "{} {} is a host-only action",
                    entry.method,
                    entry.template
                );
            }
        }
    }

    #[test]
    fn the_operator_api_is_listed_except_project_registration() {
        use axum::http::Method;
        use server_contract::routes::{
            APPROVAL, APPROVALS, APPROVAL_RESPOND, PROJECT, PROJECTS, PROJECT_ENSURE, SESSION,
            SESSIONS, SESSION_CANCEL, SESSION_CREATE, SESSION_DELEGATE, SESSION_DIFF,
            SESSION_ENTRIES, SESSION_FORK, SESSION_MERGE, SESSION_REBASE, SESSION_REFS,
            SESSION_SEND, SESSION_TRANSCRIPT, SESSION_UNQUEUE, SESSION_UPDATE, SESSION_WAIT,
            STATUS,
        };
        let operator: Vec<(&str, &str)> = vec![
            (STATUS.method.as_str(), STATUS.template),
            (PROJECTS.method.as_str(), PROJECTS.template),
            (PROJECT.method.as_str(), PROJECT.template),
            (SESSIONS.method.as_str(), SESSIONS.template),
            (SESSION_CREATE.method.as_str(), SESSION_CREATE.template),
            (SESSION.method.as_str(), SESSION.template),
            (SESSION_UPDATE.method.as_str(), SESSION_UPDATE.template),
            (SESSION_DELEGATE.method.as_str(), SESSION_DELEGATE.template),
            (SESSION_FORK.method.as_str(), SESSION_FORK.template),
            (SESSION_SEND.method.as_str(), SESSION_SEND.template),
            (SESSION_WAIT.method.as_str(), SESSION_WAIT.template),
            (SESSION_ENTRIES.method.as_str(), SESSION_ENTRIES.template),
            (
                SESSION_TRANSCRIPT.method.as_str(),
                SESSION_TRANSCRIPT.template,
            ),
            (SESSION_CANCEL.method.as_str(), SESSION_CANCEL.template),
            (SESSION_UNQUEUE.method.as_str(), SESSION_UNQUEUE.template),
            (SESSION_REFS.method.as_str(), SESSION_REFS.template),
            (SESSION_DIFF.method.as_str(), SESSION_DIFF.template),
            (SESSION_MERGE.method.as_str(), SESSION_MERGE.template),
            (SESSION_REBASE.method.as_str(), SESSION_REBASE.template),
            (APPROVALS.method.as_str(), APPROVALS.template),
            (APPROVAL.method.as_str(), APPROVAL.template),
            (APPROVAL_RESPOND.method.as_str(), APPROVAL_RESPOND.template),
        ];
        for (method, template) in operator {
            let method = Method::from_bytes(method.as_bytes()).unwrap();
            assert!(permits(&method, template), "{method} {template}");
        }
        assert!(!permits(
            &Method::from_bytes(PROJECT_ENSURE.method.as_str().as_bytes()).unwrap(),
            PROJECT_ENSURE.template
        ));
    }

    /// The desktop's own calls behind each phone screen, by the desktop
    /// source that makes them. Every one must be callable from the phone.
    /// Listed independently of `ALLOWLIST` so dropping an entry there fails
    /// here.
    const DESKTOP_CALLS_THE_PHONE_NEEDS: &[(&str, &str, &str)] = &[
        // tasks/task-api.ts
        ("GET", "/rpc/projects", "tasks/task-api.ts"),
        ("GET", "/rpc/projects/:project_id", "tasks/task-api.ts"),
        ("POST", "/rpc/projects/general", "tasks/task-api.ts"),
        (
            "POST",
            "/rpc/projects/:project_id/badge-color",
            "tasks/task-api.ts",
        ),
        ("PATCH", "/rpc/tasks/:id/status", "tasks/task-api.ts"),
        ("PATCH", "/rpc/tasks/:id/title", "tasks/task-api.ts"),
        ("POST", "/rpc/tasks/:id/cancel", "tasks/task-api.ts"),
        ("GET", "/rpc/tasks/:id/last-message", "tasks/task-api.ts"),
        ("GET", "/rpc/tasks/:id/exchanges", "tasks/task-api.ts"),
        (
            "GET",
            "/rpc/tasks/:id/exchanges/:session_id",
            "tasks/task-api.ts",
        ),
        (
            "GET",
            "/rpc/tasks/:id/pending-question",
            "tasks/task-api.ts",
        ),
        // session/utils/task-message-api.ts
        (
            "POST",
            "/rpc/tasks/:id/messages",
            "session/utils/task-message-api.ts",
        ),
        (
            "POST",
            "/rpc/tasks/:id/queue",
            "session/utils/task-message-api.ts",
        ),
        (
            "PUT",
            "/rpc/tasks/:id/queue",
            "session/utils/task-message-api.ts",
        ),
        (
            "PATCH",
            "/rpc/tasks/:id/queue/:item_id",
            "session/utils/task-message-api.ts",
        ),
        (
            "DELETE",
            "/rpc/tasks/:id/queue/:item_id",
            "session/utils/task-message-api.ts",
        ),
        (
            "POST",
            "/rpc/tasks/:id/queue/:item_id/send",
            "session/utils/task-message-api.ts",
        ),
        (
            "POST",
            "/rpc/task-runs/:id/cancel",
            "session/utils/task-message-api.ts",
        ),
        // lib/fork-client.ts
        ("POST", "/rpc/tasks/:id/fork", "lib/fork-client.ts"),
        ("POST", "/rpc/task-runs/:id/fork", "lib/fork-client.ts"),
        // session/components/conversation-fork-origin.tsx, refs
        (
            "GET",
            "/rpc/tasks/:id/runs",
            "session/components/conversation-fork-origin.tsx",
        ),
        ("GET", "/rpc/tasks/:id/context-refs", "session refs"),
        ("GET", "/rpc/tasks/:id/referenced-by", "session refs"),
        (
            "POST",
            "/rpc/tasks/:id/probe-paths",
            "lib/project-client.ts",
        ),
        // approvals
        (
            "POST",
            "/rpc/approvals/:id/respond",
            "session/components/mcp-tool-approval.tsx",
        ),
        // lib/image-client.ts
        ("POST", "/rpc/images/upload", "lib/image-client.ts"),
        (
            "POST",
            "/rpc/tasks/:id/images/upload",
            "lib/image-client.ts",
        ),
        (
            "POST",
            "/rpc/task-runs/:id/images/upload",
            "lib/image-client.ts",
        ),
        ("GET", "/rpc/images/:id/file", "lib/image-client.ts"),
        ("GET", "/rpc/images/metadata", "lib/image-client.ts"),
        ("DELETE", "/rpc/images/:id", "lib/image-client.ts"),
        // composer pickers
        ("GET", "/rpc/skills", "composer / skills"),
        ("GET", "/rpc/executor/profile", "settings/executor profile"),
        ("GET", "/rpc/executor/pi/models", "runtime picker"),
        // lib/project-client.ts: Files, Search, editor, gallery
        (
            "GET",
            "/rpc/projects/:project_id/entries",
            "lib/project-client.ts",
        ),
        (
            "GET",
            "/rpc/projects/:project_id/file",
            "lib/project-client.ts",
        ),
        (
            "PUT",
            "/rpc/projects/:project_id/file",
            "lib/project-client.ts",
        ),
        (
            "GET",
            "/rpc/projects/:project_id/search",
            "lib/project-client.ts",
        ),
        (
            "GET",
            "/rpc/projects/:project_id/resolve-file",
            "lib/project-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/probe-paths",
            "lib/project-client.ts",
        ),
        (
            "GET",
            "/rpc/projects/:project_id/media",
            "lib/project-client.ts",
        ),
        ("GET", "/rpc/projects/:project_id/tree", "directory map"),
        (
            "GET",
            "/rpc/projects/:project_id/directory-agent",
            "directory-agent-panel.tsx",
        ),
        ("GET", "/rpc/task-runs/:id/entries", "lib/project-client.ts"),
        ("GET", "/rpc/task-runs/:id/file", "lib/project-client.ts"),
        ("PUT", "/rpc/task-runs/:id/file", "lib/project-client.ts"),
        (
            "GET",
            "/rpc/task-runs/:id/resolve-file",
            "lib/project-client.ts",
        ),
        ("GET", "/rpc/task-runs/:id/media", "lib/project-client.ts"),
        // cbase/cbase-client.ts
        (
            "POST",
            "/rpc/projects/:project_id/cbase/query",
            "cbase/cbase-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/cbase/persist",
            "cbase/cbase-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/cbase/set-property",
            "cbase/cbase-client.ts",
        ),
        // lib/git-client.ts (both scopes)
        (
            "GET",
            "/rpc/projects/:project_id/git/status",
            "lib/git-client.ts",
        ),
        (
            "GET",
            "/rpc/projects/:project_id/git/diff",
            "lib/git-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/git/commit",
            "lib/git-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/git/push",
            "lib/git-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/git/pull",
            "lib/git-client.ts",
        ),
        ("GET", "/rpc/task-runs/:id/git/status", "lib/git-client.ts"),
        ("GET", "/rpc/task-runs/:id/git/diff", "lib/git-client.ts"),
        ("POST", "/rpc/task-runs/:id/git/commit", "lib/git-client.ts"),
        // hooks/use-merge-run.ts, hooks/use-rebase.ts, branch status
        ("POST", "/rpc/task-runs/:id/merge", "hooks/use-merge-run.ts"),
        ("POST", "/rpc/task-runs/:id/rebase", "hooks/use-rebase.ts"),
        (
            "POST",
            "/rpc/task-runs/:id/conflicts/abort",
            "conflict notice",
        ),
        (
            "GET",
            "/rpc/task-runs/:id/branch-status",
            "run-status-pill.tsx",
        ),
        // settings
        ("GET", "/rpc/preferences", "settings"),
        ("PUT", "/rpc/preferences", "settings"),
        ("GET", "/rpc/preferences/merge", "settings"),
        ("PUT", "/rpc/preferences/merge", "settings"),
        ("GET", "/rpc/preferences/editor", "settings"),
        ("PUT", "/rpc/preferences/editor", "settings"),
        (
            "GET",
            "/rpc/preferences/appearance",
            "lib/preferences-client.ts (accent)",
        ),
        (
            "PUT",
            "/rpc/preferences/appearance",
            "lib/preferences-client.ts (accent)",
        ),
        ("GET", "/rpc/mcp-config", "lib/mcp-config-client.ts"),
        ("PUT", "/rpc/mcp-config", "lib/mcp-config-client.ts"),
        ("GET", "/rpc/executor/mcp-status", "lib/executor-client.ts"),
        // shared UI state: pins, read marks, order, open tabs, recent folders
        ("GET", "/rpc/ui-state", "lib/ui-state-client.ts"),
        ("PUT", "/rpc/ui-state", "lib/ui-state-client.ts"),
        // opening a folder as a project
        (
            "GET",
            "/rpc/filesystem/directory",
            "lib/filesystem-client.ts",
        ),
        ("POST", "/rpc/projects/ensure", "tasks/task-api.ts"),
        // Files panel: new folder, rename or move, duplicate, delete
        (
            "POST",
            "/rpc/projects/:project_id/directory",
            "lib/project-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/rename",
            "lib/project-client.ts",
        ),
        (
            "POST",
            "/rpc/projects/:project_id/copy",
            "lib/project-client.ts",
        ),
        (
            "DELETE",
            "/rpc/projects/:project_id/file",
            "lib/project-client.ts",
        ),
        // system
        ("GET", "/rpc/cli-status", "cli status dropdown"),
        ("GET", "/rpc/agent-usage", "usage meter"),
        ("GET", "/rpc/flags/registry", "feature flags"),
    ];

    #[test]
    fn every_desktop_call_behind_a_phone_screen_is_listed() {
        for (method, template, source) in DESKTOP_CALLS_THE_PHONE_NEEDS {
            let method = Method::from_bytes(method.as_bytes()).unwrap();
            assert!(
                permits(&method, template),
                "{method} {template} (called from {source}) is missing from the device allowlist"
            );
        }
    }

    /// Streams the desktop opens as WebSockets behind phone screens. Devices
    /// reach them with `subscribe`, never with `request`.
    const DESKTOP_STREAMS_THE_PHONE_NEEDS: &[(&str, &str)] = &[
        ("/streams/tasks", "sidebar"),
        (
            "/streams/tasks/:task_id/runs",
            "session/hooks/use-task-runs-stream.ts",
        ),
        (
            "/streams/tasks/:task_id/sessions",
            "session/hooks/use-task-sessions-stream.ts",
        ),
        ("/streams/tasks/:task_id/queue", "session queue"),
        (
            "/streams/task-runs/:id/logs",
            "session/hooks/use-task-log-stream.ts",
        ),
        ("/streams/task-runs/:id/repo-events", "repo events"),
        ("/streams/projects/:project_id/repo-events", "repo events"),
        (
            "/rpc/task-runs/:id/diff",
            "session/hooks/use-diff-stream.ts",
        ),
        // Phone-only: the session list window (architecture doc §27).
        ("/streams/session-list", "phone session list"),
    ];

    #[test]
    fn every_desktop_stream_behind_a_phone_screen_is_subscribable() {
        use crate::routes::stream_sources::STREAM_TEMPLATES;
        for (template, source) in DESKTOP_STREAMS_THE_PHONE_NEEDS {
            assert!(
                STREAM_TEMPLATES
                    .iter()
                    .any(|listed| listed.split('?').next() == Some(*template)),
                "{template} (opened by {source}) is not subscribable"
            );
            assert!(
                !ALLOWLIST.iter().any(|entry| entry.template == *template),
                "{template} is a WebSocket; listing it for request would only fail the upgrade"
            );
        }
    }

    #[test]
    fn every_surface_has_endpoints() {
        let surfaces: HashSet<Surface> = ALLOWLIST.iter().map(|entry| entry.surface).collect();
        for surface in [
            Sessions,
            Conversation,
            Composer,
            Approvals,
            Files,
            SourceControl,
            Editor,
            Gallery,
            Agent,
            Settings,
            System,
        ] {
            assert!(surfaces.contains(&surface), "{surface:?}");
        }
    }
}
