import { desktopFetch } from "@/lib/backend-client";
import type { StartClaudeResponse } from "@/session/types";
import type { ExecutorProfileId } from "@/lib/executor-client";
import type { TaskRecord } from "../state/task-store";

export interface ProjectResponse {
  id: string;
  slug?: string | null;
  name: string;
  gitRepoPath: string;
}

interface EnsureProjectResponse {
  project: ProjectResponse;
}

interface GetProjectResponse {
  project: {
    id: string;
    slug?: string | null;
    name: string;
    git_repo_path: string;
  };
}

interface CreateTaskResponse {
  task: TaskRecord;
}

interface ListTasksResponse {
  tasks: TaskRecord[];
}

export const taskApi = {
  list: async (workspacePath: string): Promise<TaskRecord[]> => {
    const response = await desktopFetch<ListTasksResponse>(
      `/tasks?workspace_path=${encodeURIComponent(workspacePath)}`,
    );
    return response.tasks;
  },

  create: async (
    projectId: string,
    title: string | null,
    description: string | null,
    prompt: string | null = null,
  ): Promise<TaskRecord> => {
    const response = await desktopFetch<CreateTaskResponse>("/rpc/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: projectId,
        title,
        description,
        prompt,
      }),
    });
    return response.task;
  },

  updateStatus: async (taskId: string, status: string): Promise<void> => {
    await desktopFetch(`/rpc/tasks/${taskId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  },

  updateTitle: async (taskId: string, title: string): Promise<TaskRecord> => {
    const response = await desktopFetch<{ task: TaskRecord }>(
      `/rpc/tasks/${taskId}/title`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      },
    );
    return response.task;
  },

  delete: async (taskId: string): Promise<void> => {
    await desktopFetch(`/rpc/tasks/${taskId}`, { method: "DELETE" });
  },

  reorder: async (
    tasks: Array<{ id: string; sort_order: number }>,
  ): Promise<void> => {
    await desktopFetch("/rpc/tasks/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks }),
    });
  },

  ensureProject: async (
    gitRepoPath: string,
  ): Promise<{ id: string; slug: string }> => {
    const response = await desktopFetch<EnsureProjectResponse>(
      "/rpc/projects/ensure",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ git_repo_path: gitRepoPath }),
      },
    );
    return {
      id: response.project.id,
      slug: response.project.slug ?? response.project.id,
    };
  },

  getProject: async (projectId: string): Promise<ProjectResponse> => {
    const response = await desktopFetch<GetProjectResponse>(
      `/rpc/projects/${encodeURIComponent(projectId)}`,
    );
    return {
      id: response.project.id,
      slug: response.project.slug,
      name: response.project.name,
      gitRepoPath: response.project.git_repo_path,
    };
  },

  startClaudeExecution: async (
    workspacePath: string,
    taskId: string,
    options?: {
      useWorktree?: boolean;
      executorProfileId?: ExecutorProfileId | null;
      targetBranch?: string;
    },
  ): Promise<StartClaudeResponse> => {
    return desktopFetch<StartClaudeResponse>("/rpc/executions/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "",
        workspace_path: workspacePath,
        task_id: taskId,
        force_new_attempt: true,
        use_worktree: options?.useWorktree,
        executor_profile_id: options?.executorProfileId ?? undefined,
        target_branch: options?.targetBranch ?? undefined,
      }),
    });
  },
};
