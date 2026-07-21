import { desktopFetch } from "@/lib/backend-client";

/**
 * Where a forked session works.
 *
 * Only meaningful for git projects. General chats and non-git projects share
 * the source directory, so callers there omit it and the server defaults to
 * "same".
 */
export type ForkWorkspace = "same" | "new_worktree";

/**
 * How the fork inherited its conversation. Decided by the server, never asked
 * of the user: "digest" means the source could not be duplicated (its last run
 * ended on an error, or the agent cannot branch) so only a summary carries over.
 */
export type ForkMode = "native" | "digest";

export interface ForkedTask {
  id: string;
  slug: string | null;
  title: string;
  project_id: string;
}

export interface ForkResult {
  task: ForkedTask;
  mode: ForkMode;
}

/**
 * Branch the session at `taskRunId` into a new task.
 *
 * The new task starts idle: forking is not a request, so nothing runs until the
 * caller writes the first turn.
 */
export async function forkTaskRun(
  taskRunId: string,
  workspace?: ForkWorkspace,
): Promise<ForkResult> {
  return desktopFetch<ForkResult>(
    `/rpc/task-runs/${encodeURIComponent(taskRunId)}/fork`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workspace ? { workspace } : {}),
    },
  );
}

/**
 * Branch a session from its latest finished run.
 *
 * For entry points that carry no anchor — the session list — where "latest" is
 * the only point the user could have meant.
 */
export async function forkTaskLatest(
  taskId: string,
  workspace?: ForkWorkspace,
): Promise<ForkResult> {
  return desktopFetch<ForkResult>(
    `/rpc/tasks/${encodeURIComponent(taskId)}/fork`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workspace ? { workspace } : {}),
    },
  );
}
