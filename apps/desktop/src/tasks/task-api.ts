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
}

interface RawProjectPayload {
  id: string;
  slug?: string | null;
  name: string;
  git_repo_path: string;
}

interface EnsureProjectResponse {
  project: RawProjectPayload;
}

interface GetProjectResponse {
  project: RawProjectPayload;
}

const toProjectResponse = (payload: RawProjectPayload): ProjectResponse => ({
  id: payload.id,
  slug: payload.slug,
  name: payload.name,
  gitRepoPath: payload.git_repo_path,
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
    return response.projects.map(toProjectResponse);
  },

  updateStatus: async (taskId: string, status: string): Promise<void> => {
    await desktopFetch(`/rpc/tasks/${taskId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
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

  ensureProject: async (gitRepoPath: string): Promise<ProjectResponse> => {
    const response = await desktopFetch<EnsureProjectResponse>(
      "/rpc/projects/ensure",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ git_repo_path: gitRepoPath }),
      },
    );
    return toProjectResponse(response.project);
  },

  getProject: async (projectId: string): Promise<ProjectResponse> => {
    const response = await desktopFetch<GetProjectResponse>(
      `/rpc/projects/${encodeURIComponent(projectId)}`,
    );
    return toProjectResponse(response.project);
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
