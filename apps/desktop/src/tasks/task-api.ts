import { desktopFetch } from "@/lib/backend-client";

/**
 * Task / project data layer shared by the session surface.
 *
 * Tasks are the persistence backing for agent sessions: a session is bound to
 * a task row, and project resolution maps a workspace path to a project id.
 * This module exposes only the operations the session feature needs.
 */

/**
 * TaskStatus from the backend database.
 */
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * TaskRecord from the backend database.
 */
export interface TaskRecord {
  id: string;
  slug?: string | null;
  project_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  due_at: string | null;
  branch: string | null;
  worktree_path: string | null;
  worktree_deleted: boolean;
  active_session_id: string | null;
  created_at: string;
  updated_at: string;
  sort_order: number;
}

export interface ProjectResponse {
  id: string;
  slug?: string | null;
  name: string;
  gitRepoPath: string;
  /**
   * True for the hidden "General" project that backs general-purpose
   * ("scratch") chats. Drives hiding git affordances and showing the
   * "Choose project" picker in the new-chat composer.
   */
  isGeneral: boolean;
}

interface RawProjectPayload {
  id: string;
  slug?: string | null;
  name: string;
  git_repo_path: string;
  /** Present on the project-list response; flags the hidden "General" project. */
  is_general?: boolean;
}

interface EnsureProjectResponse {
  project: RawProjectPayload;
  is_general?: boolean;
}

interface GetProjectResponse {
  project: RawProjectPayload;
  is_general?: boolean;
}

const toProjectResponse = (
  payload: RawProjectPayload,
  isGeneral = false,
): ProjectResponse => ({
  id: payload.id,
  slug: payload.slug,
  name: payload.name,
  gitRepoPath: payload.git_repo_path,
  isGeneral,
});

export const taskApi = {
  list: async (workspacePath: string): Promise<TaskRecord[]> => {
    const response = await desktopFetch<{ tasks: TaskRecord[] }>(
      `/tasks?workspace_path=${encodeURIComponent(workspacePath)}`,
    );
    return response.tasks;
  },

  listProjects: async (): Promise<ProjectResponse[]> => {
    const response = await desktopFetch<{ projects: RawProjectPayload[] }>(
      "/rpc/projects",
    );
    return response.projects.map((project) =>
      toProjectResponse(project, project.is_general),
    );
  },

  updateStatus: async (taskId: string, status: string): Promise<void> => {
    await desktopFetch(`/rpc/tasks/${taskId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  },

  /**
   * Cancel a task's active run. Forces the run to a terminal status and clears
   * the task's `active_session_id`, so a session that is stuck "running" (e.g.
   * an orphaned run whose process already exited) settles. A no-op (404) when
   * there is no run to cancel.
   */
  cancel: async (taskId: string): Promise<void> => {
    await desktopFetch(`/rpc/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: "POST",
    });
  },

  /**
   * Fetch the most recent user prompt and assistant reply for a task. Either
   * field is `null` when that message type has not been produced yet. Used for
   * the sidebar hover preview, so it stays a single cheap request instead of
   * opening the full conversation stream.
   */
  lastExchange: async (
    taskId: string,
  ): Promise<{ user: string | null; assistant: string | null }> => {
    const response = await desktopFetch<{
      user: string | null;
      assistant: string | null;
    }>(`/rpc/tasks/${encodeURIComponent(taskId)}/last-message`);
    return {
      user: response.user ?? null,
      assistant: response.assistant ?? null,
    };
  },

  /**
   * Fetch the approval request the task's running agent is blocked on, if any
   * (signalled by `awaiting_input` on the task). `tool_input` carries the
   * AskUserQuestion payload so the hover preview can show the question text.
   */
  pendingQuestion: async (
    taskId: string,
  ): Promise<{
    tool_name: string;
    tool_input: unknown;
  } | null> => {
    const response = await desktopFetch<{
      approval: { tool_name: string; tool_input: unknown } | null;
    }>(`/rpc/tasks/${encodeURIComponent(taskId)}/pending-question`);
    return response.approval ?? null;
  },

  ensureProject: async (gitRepoPath: string): Promise<ProjectResponse> => {
    const response = await desktopFetch<EnsureProjectResponse>(
      "/rpc/projects/ensure",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ git_repo_path: gitRepoPath }),
      },
    );
    return toProjectResponse(response.project, response.is_general);
  },

  getProject: async (projectId: string): Promise<ProjectResponse> => {
    const response = await desktopFetch<GetProjectResponse>(
      `/rpc/projects/${encodeURIComponent(projectId)}`,
    );
    return toProjectResponse(response.project, response.is_general);
  },

  /**
   * Ensure the hidden "General" project that backs general-purpose ("scratch")
   * chats and return it. Idempotent. Used by the left-panel "New chat" action
   * to resolve the slug it navigates to without opening the project in the tree.
   */
  ensureGeneralProject: async (): Promise<ProjectResponse> => {
    const response = await desktopFetch<EnsureProjectResponse>(
      "/rpc/projects/general",
      { method: "POST" },
    );
    return toProjectResponse(response.project, response.is_general);
  },
};

/**
 * Update a task title. The change appears in the WebSocket stream automatically.
 */
export async function updateTaskTitle(
  taskId: string,
  title: string,
): Promise<TaskRecord> {
  const response = await desktopFetch<{ task: TaskRecord }>(
    `/rpc/tasks/${taskId}/title`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  return response.task;
}
