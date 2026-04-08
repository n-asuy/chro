import type { App } from "electron";
import { join } from "node:path";

export type Timestamp = string;

export interface ProjectRecord {
  id: string;
  name: string;
  git_repo_path: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskRecord {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskAttemptRecord {
  id: string;
  task_id: string;
  executor: string | null;
  branch: string | null;
  target_branch: string | null;
  container_ref: string | null;
  worktree_deleted: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type ExecutionProcessStatus =
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "pending"
  | "cancelled";

export interface ExecutionProcessRecord {
  id: string;
  task_attempt_id: string;
  run_reason: string | null;
  status: ExecutionProcessStatus;
  exit_code: number | null;
  executor: string | null;
  resume_from_session_id: string | null;
  before_head_commit: string | null;
  after_head_commit: string | null;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ExecutorSessionRecord {
  id: string;
  task_attempt_id: string;
  execution_process_id: string;
  session_id: string | null;
  prompt: string | null;
  summary: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SessionSummaryEntry {
  executor_session_id: string;
  session_id: string | null;
  prompt: string | null;
  summary: string | null;
  task_id: string;
  task_title: string;
  task_attempt_id: string;
  execution_process_id: string;
  status: ExecutionProcessRecord["status"];
  exit_code: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface TaskComposite {
  attempt: TaskAttemptRecord;
  task: TaskRecord;
  project: ProjectRecord;
}

export interface SessionDatabase {
  close(): void;
  getOrCreateProject(workspacePath: string): Promise<ProjectRecord>;
  createTask(
    projectId: string,
    title: string | null,
    description?: string | null,
    prompt?: string | null,
  ): Promise<TaskRecord>;
  createTaskAttempt(
    taskId: string,
    executor: string,
  ): Promise<TaskAttemptRecord>;
  createExecutionProcess(input: {
    taskAttemptId: string;
    runReason: string;
    executor: string;
    resumeSessionId?: string | null;
  }): Promise<ExecutionProcessRecord>;
  createExecutorSession(input: {
    taskAttemptId: string;
    executionProcessId: string;
    prompt: string;
  }): Promise<ExecutorSessionRecord>;
  updateExecutorSessionId(
    executorSessionId: string,
    sessionId: string,
  ): Promise<void>;
  updateExecutionProcessStatus(input: {
    executionProcessId: string;
    status: Exclude<ExecutionProcessStatus, "running">;
    exitCode: number | null;
  }): Promise<void>;
  updateTaskAttemptGitData(input: {
    taskAttemptId: string;
    branch?: string;
    targetBranch?: string;
    containerRef?: string;
  }): Promise<TaskAttemptRecord>;
  markWorktreeDeleted(taskAttemptId: string): Promise<void>;
  listActiveWorktrees(): Promise<
    Array<{
      task_attempt_id: string;
      container_ref: string;
      branch: string | null;
      target_branch: string | null;
      updated_at: Timestamp;
    }>
  >;
  updateExecutorSessionSummary(
    executorSessionId: string,
    summary: string,
  ): Promise<void>;
  getLatestActiveAttemptForProject(
    projectId: string,
  ): Promise<{ attempt: TaskAttemptRecord; task: TaskRecord } | null>;
  findTaskAttemptIdBySessionId(sessionId: string): Promise<string | null>;
  getTaskAttemptWithTask(taskAttemptId: string): Promise<TaskComposite | null>;
  listSessionsForProject(projectId: string): Promise<SessionSummaryEntry[]>;
}

export const SHARED_APP_DIR_NAME = "Chro";

const HTTP_OK_NO_CONTENT = 204;

type HttpError = NodeJS.ErrnoException & { status?: number };

class HttpSessionDatabase implements SessionDatabase {
  constructor(private readonly baseUrl: string) {}

  close(): void {
    // Nothing to dispose for HTTP implementation
  }

  async getOrCreateProject(workspacePath: string): Promise<ProjectRecord> {
    const result = await this.post<{ project: ProjectRecord }>(
      "/rpc/projects/ensure",
      {
        git_repo_path: workspacePath,
      },
    );
    return result.project;
  }

  async createTask(
    projectId: string,
    title: string | null,
    description: string | null = null,
    prompt: string | null = null,
  ): Promise<TaskRecord> {
    const result = await this.post<{ task: TaskRecord }>("/rpc/tasks", {
      project_id: projectId,
      title,
      description,
      prompt,
    });
    return result.task;
  }

  async createTaskAttempt(
    taskId: string,
    executor: string,
  ): Promise<TaskAttemptRecord> {
    const result = await this.post<{ attempt: TaskAttemptRecord }>(
      "/rpc/task-runs",
      {
        task_id: taskId,
        executor,
      },
    );
    return result.attempt;
  }

  async createExecutionProcess(input: {
    taskAttemptId: string;
    runReason: string;
    executor: string;
    resumeSessionId?: string | null;
  }): Promise<ExecutionProcessRecord> {
    const result = await this.post<{ execution: ExecutionProcessRecord }>(
      `/rpc/task-runs/${input.taskAttemptId}/executions`,
      {
        task_attempt_id: input.taskAttemptId,
        run_reason: input.runReason,
        executor: input.executor,
        resume_session_id: input.resumeSessionId ?? null,
      },
    );
    return result.execution;
  }

  async createExecutorSession(input: {
    taskAttemptId: string;
    executionProcessId: string;
    prompt: string;
  }): Promise<ExecutorSessionRecord> {
    const result = await this.post<{ session: ExecutorSessionRecord }>(
      "/rpc/task-sessions",
      {
        task_attempt_id: input.taskAttemptId,
        execution_process_id: input.executionProcessId,
        prompt: input.prompt,
      },
    );
    return result.session;
  }

  async updateExecutorSessionId(
    executorSessionId: string,
    sessionId: string,
  ): Promise<void> {
    await this.patch<void>(`/rpc/task-sessions/${executorSessionId}/external`, {
      session_id: sessionId,
    });
  }

  async updateExecutionProcessStatus(input: {
    executionProcessId: string;
    status: Exclude<ExecutionProcessStatus, "running">;
    exitCode: number | null;
  }): Promise<void> {
    await this.patch<void>(
      `/rpc/task-runs/${input.executionProcessId}/status`,
      {
        status: input.status,
        exit_code: input.exitCode,
      },
    );
  }

  async updateTaskAttemptGitData(input: {
    taskAttemptId: string;
    branch?: string;
    targetBranch?: string;
    containerRef?: string;
  }): Promise<TaskAttemptRecord> {
    const result = await this.patch<{ attempt: TaskAttemptRecord }>(
      `/rpc/task-runs/${input.taskAttemptId}/git`,
      {
        branch: input.branch ?? null,
        target_branch: input.targetBranch ?? null,
        container_ref: input.containerRef ?? null,
        workspace_path: input.containerRef ?? null,
      },
    );
    return result.attempt;
  }

  async markWorktreeDeleted(taskAttemptId: string): Promise<void> {
    await this.patch<void>(
      `/rpc/task-runs/${taskAttemptId}/worktree-deleted`,
      {},
    );
  }

  async listActiveWorktrees(): Promise<
    Array<{
      task_attempt_id: string;
      container_ref: string;
      branch: string | null;
      target_branch: string | null;
      updated_at: Timestamp;
    }>
  > {
    // TODO: implement dedicated endpoint when the tray UI consumes it.
    return [];
  }

  async updateExecutorSessionSummary(
    _executorSessionId: string,
    _summary: string,
  ): Promise<void> {
    // Placeholder: summaries are not persisted yet in the Rust backend.
  }

  async getLatestActiveAttemptForProject(
    projectId: string,
  ): Promise<{ attempt: TaskAttemptRecord; task: TaskRecord } | null> {
    try {
      const result = await this.get<{
        attempt: TaskAttemptRecord;
        task: TaskRecord;
      }>(`/rpc/projects/${projectId}/active-run`);
      return result;
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async findTaskAttemptIdBySessionId(
    sessionId: string,
  ): Promise<string | null> {
    const result = await this.get<string | null>(
      `/rpc/task-runs/by-session/${encodeURIComponent(sessionId)}`,
    );
    return result;
  }

  async getTaskAttemptWithTask(
    taskAttemptId: string,
  ): Promise<TaskComposite | null> {
    try {
      return await this.get<TaskComposite>(
        `/rpc/task-runs/${taskAttemptId}/with-task`,
      );
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async listSessionsForProject(
    projectId: string,
  ): Promise<SessionSummaryEntry[]> {
    const result = await this.get<{ sessions: SessionSummaryEntry[] }>(
      `/rpc/projects/${projectId}/sessions`,
    );
    return result.sessions;
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" });
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async patch<T>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    return this.request<T>(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const target = `${this.baseUrl}${path}`;
    const response = await fetch(target, init);
    if (!response.ok) {
      if (response.status === HTTP_OK_NO_CONTENT) {
        return {} as T;
      }
      const text = await response.text();
      const error: HttpError = new Error(
        text || `Request to ${target} failed with status ${response.status}`,
      );
      error.status = response.status;
      throw error;
    }

    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      return {} as T;
    }
    return (await response.json()) as T;
  }
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  Reflect.get(error as object, "status") === 404;

export function createSessionDatabase(
  userDataPath: string,
  options: { baseUrl: string },
): SessionDatabase {
  if (!options.baseUrl) {
    throw new Error("Session database requires a backend base URL");
  }
  const normalized = options.baseUrl.replace(/\/$/, "");
  return new HttpSessionDatabase(normalized);
}

export function configureSharedUserData(
  app: App,
  dirName = SHARED_APP_DIR_NAME,
): string {
  const target = join(app.getPath("appData"), dirName);
  app.setPath("userData", target);
  return target;
}
