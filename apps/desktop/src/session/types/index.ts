export * from "./normalized";
export * from "./execution-process";
export * from "./api";
export * from "./context";

/**
 * Stored task record from database
 */
export type StoredTask = {
  id: string;
  slug?: string | null;
  project_id: string;
  title: string;
  description?: string | null;
  status: string;
  branch?: string | null;
  active_session_id?: string | null;
  /** True while the agent is blocked on an AskUserQuestion, waiting for the
   * user to answer. The session list shows a paused indicator instead of the
   * running spinner. */
  awaiting_input?: boolean;
  created_at: string;
  updated_at: string;
  sort_order: number;
  /** Bare agent kind the task last ran with (e.g. "CLAUDE_CODE", "CODEX"). */
  last_executor?: string | null;
  /** One-line outcome of the latest completed run, derived from the final
   * assistant message. Undefined until a run completes. */
  last_summary?: string | null;
  /** Title of the session this one was forked from, snapshotted at fork time.
   * Shown as provenance in the session list. Undefined for sessions that were
   * not forked. */
  forked_from_title?: string | null;
  /** Title of the session that delegated this one, snapshotted at delegation
   * time. Same provenance contract as `forked_from_title`. */
  delegated_from_title?: string | null;
  /** True once housekeeping has reclaimed the run's isolated worktree. The
   * session turns read-only: its workspace path is gone, so it can no longer be
   * continued, merged or rebased — only its history remains readable. */
  worktree_deleted?: boolean;
};
