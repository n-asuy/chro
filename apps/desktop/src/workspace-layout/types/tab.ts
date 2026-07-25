/**
 * A Tab is the smallest navigable unit inside a Pane. Every center-area
 * surface — editor, diff, session, settings, search results — is
 * modeled as a Tab. The kind discriminator carries the routing payload.
 *
 * Mirrors VSCode `EditorInput` and Zed `Item` in spirit.
 */

export type TabKind =
  // Project home: a minimal landing surface listing the project's recent
  // sessions. Shown when switching to / opening a project. One per project.
  | { type: "overview" }
  | { type: "session"; taskId?: string; runId?: string }
  | {
      type: "file";
      /**
       * Path of the file to open. Always interpreted by the server against the
       * resource scope: worktree-relative when `taskRunId` is set, otherwise
       * project-relative. The server tolerates absolute paths that lie under
       * the resolved root, and read endpoints additionally serve absolute paths
       * outside every workspace root directly (see `resolve_workspace_path` in
       * `crates/server/src/routes/rpc/path_resolve.rs`).
       */
      path: string;
      taskRunId?: string;
    }
  // Combined diff for a run: every changed file stacked. One tab per run —
  // `runId` is the whole identity. A file is an anchor inside this tab, not a
  // tab of its own (see `requestDiffReveal`), so it never enters the key.
  | { type: "diff"; runId: string }
  // Combined working-tree diff for the project: every uncommitted change
  // stacked as a diff (changed regions only). One tab per project —
  // `projectId` is the identity.
  | { type: "project-diff"; projectId: string }
  // In-app browser: the page renders directly in an iframe inside the pane.
  | { type: "browser"; browserId?: string; url?: string }
  // CDP browser: a real Chrome driven over CDP, streamed in as screencast
  // frames. Handles frame-busting sites the iframe browser cannot embed.
  | { type: "cdp-browser"; browserId?: string; url?: string }
  | { type: "settings" }
  // Skill browser: lists the project's workspace skills plus the user's
  // global skills (~/.claude, ~/.agents, ~/.codex). One per project.
  | { type: "skills" }
  // Media gallery: a full-width grid of the renderable images/videos found on
  // disk. Scope follows the file tree — worktree-relative when `taskRunId` is
  // set (a session's creatives), otherwise the project's main checkout.
  | { type: "gallery"; taskRunId?: string };

export type TabKindType = TabKind["type"];

export interface Tab {
  /** Stable instance id; survives reload via persistence */
  id: string;
  kind: TabKind;
  /** Display label shown on the tab. Resolved by the registry on render */
  title: string;
  /** Optional icon name (lucide). Resolved by the registry */
  iconName?: string;
  /** True if user has pinned the tab (closes via explicit action only) */
  pinned?: boolean;
  /** True if the underlying content has unsaved changes */
  dirty?: boolean;
}

/**
 * Identifier for a Tab without instance id. Used for de-duplication when
 * `openTab` would otherwise create a redundant duplicate of the same logical
 * resource (e.g. opening the same file twice should focus the existing tab).
 */
export type TabKey = string;

export function tabKey(kind: TabKind): TabKey {
  switch (kind.type) {
    case "overview":
      return "overview";
    case "session":
      // Per docs/20260419 §1: same taskId → focus existing tab.
      // runId is internal navigation within the session, not a new tab.
      // A session without a taskId is a "new session / chat start" tab.
      // `openTab` treats these as duplicable so the plus button can always
      // create a fresh blank session.
      return kind.taskId ? `session:${kind.taskId}` : "session:new";
    case "file":
      return kind.taskRunId
        ? `file:${kind.taskRunId}:${kind.path}`
        : `file:${kind.path}`;
    case "diff":
      return `diff:${kind.runId}`;
    case "project-diff":
      return `project-diff:${kind.projectId}`;
    case "browser":
      return `browser:${kind.browserId ?? "new"}`;
    case "cdp-browser":
      return `cdp-browser:${kind.browserId ?? "new"}`;
    case "settings":
      return "settings";
    case "skills":
      return "skills";
    case "gallery":
      // One gallery per scope: the project gallery and each run's gallery are
      // distinct tabs, but re-opening the same scope focuses the existing one.
      return kind.taskRunId ? `gallery:${kind.taskRunId}` : "gallery";
  }
}

/**
 * Whether a kind allows multiple instances of the same payload to coexist as
 * separate tabs. Browser tabs own their own sessions, so the plus button must
 * always be able to open a fresh one.
 */
export function isDuplicableKind(type: TabKindType): boolean {
  return type === "browser" || type === "cdp-browser";
}
