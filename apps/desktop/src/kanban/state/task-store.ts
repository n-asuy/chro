import { desktopFetch } from "@/lib/backend-client";
import type { BoardColumn, BoardIssue, IssueState } from "../types";

/**
 * TaskStatus from the backend database
 */
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * TaskRecord from the backend database
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

/**
 * Column definition for mapping TaskStatus to kanban columns
 */
interface ColumnDefinition {
  id: string;
  title: string;
  accent: string;
  statuses: TaskStatus[];
  state: IssueState;
}

/**
 * Kanban column definitions with TaskStatus mapping
 */
export const COLUMN_DEFINITIONS: ColumnDefinition[] = [
  {
    id: "planning",
    title: "Planning",
    accent: "bg-amber-200",
    statuses: ["pending"],
    state: {
      id: "backlog",
      name: "Backlog",
      color: "#94A3B8",
      group: "backlog",
    },
  },
  {
    id: "progress",
    title: "In progress",
    accent: "bg-sky-200",
    statuses: ["in_progress", "blocked", "failed"],
    state: {
      id: "progress",
      name: "In progress",
      color: "#2563EB",
      group: "started",
    },
  },
  {
    id: "done",
    title: "Done",
    accent: "bg-emerald-200",
    statuses: ["completed"],
    state: { id: "done", name: "Done", color: "#22C55E", group: "completed" },
  },
  {
    id: "archived",
    title: "Archived",
    accent: "bg-rose-200",
    statuses: ["cancelled"],
    state: {
      id: "archived",
      name: "Archived",
      color: "#F87171",
      group: "completed",
    },
  },
];

/**
 * Map TaskStatus to column ID
 */
export const statusToColumnId = (status: TaskStatus): string => {
  const column = COLUMN_DEFINITIONS.find((col) =>
    col.statuses.includes(status),
  );
  return column?.id ?? "planning";
};

/**
 * Map column ID to TaskStatus
 */
export const columnIdToStatus = (columnId: string): TaskStatus => {
  const column = COLUMN_DEFINITIONS.find((col) => col.id === columnId);
  return column?.statuses[0] ?? "pending";
};

/**
 * Display-friendly key for a task (Git-style prefix derived from UUID, fallback to sequence)
 */
export const formatTaskKey = (
  taskId?: string | null,
  sequenceId?: number,
): string => {
  if (taskId && taskId.trim().length > 0) {
    const compact = taskId.replace(/-/g, "").slice(0, 8);
    if (compact) {
      return compact.toLowerCase();
    }
  }
  if (typeof sequenceId === "number") {
    return sequenceId.toString();
  }
  return "";
};

/**
 * Convert TaskRecord to BoardIssue
 */
const taskToBoardIssue = (task: TaskRecord, sequenceId: number): BoardIssue => {
  const columnDef = COLUMN_DEFINITIONS.find((col) =>
    col.statuses.includes(task.status),
  );

  return {
    id: task.id,
    slug: task.slug,
    sequenceId,
    key: formatTaskKey(task.id, sequenceId),
    title: task.title,
    summary: task.description ?? "",
    description: task.description ?? "",
    branch: task.branch ?? null,
    activeSessionId: task.active_session_id ?? null,
    priority: "medium",
    state: columnDef?.state ?? COLUMN_DEFINITIONS[0].state,
    labels: [],
    startDate: undefined,
    dueDate: task.due_at ?? undefined,
    assignees: [],
    attachments: 0,
    links: 0,
    subIssues: 0,
    watchers: 0,
    votes: 0,
    reactions: [],
    subtasks: [],
    activity: [],
    comments: [],
    projectIdentifier: "TASK",
    projectName: "Tasks",
    updatedAt: task.updated_at,
    createdAt: task.created_at,
  };
};

/**
 * Convert TaskRecord array to BoardColumn array
 */
export const tasksToBoardColumns = (tasks: TaskRecord[]): BoardColumn[] => {
  const tasksByColumn = new Map<string, TaskRecord[]>();

  // Initialize empty arrays for all columns
  for (const col of COLUMN_DEFINITIONS) {
    tasksByColumn.set(col.id, []);
  }

  // Group tasks by column based on status
  for (const task of tasks) {
    const columnId = statusToColumnId(task.status);
    const columnTasks = tasksByColumn.get(columnId) ?? [];
    columnTasks.push(task);
    tasksByColumn.set(columnId, columnTasks);
  }

  // Convert to BoardColumn array
  return COLUMN_DEFINITIONS.map((col) => {
    const columnTasks = tasksByColumn.get(col.id) ?? [];
    // Sort by sort_order ascending, then updated_at descending as tiebreaker
    columnTasks.sort((a, b) => {
      const orderDiff = a.sort_order - b.sort_order;
      if (orderDiff !== 0) return orderDiff;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    });

    return {
      id: col.id,
      title: col.title,
      accent: col.accent,
      issues: columnTasks.map((task, index) =>
        taskToBoardIssue(task, index + 1),
      ),
    };
  });
};

// =============================================================================
// Task API functions (mutations only - reads are via WebSocket)
// =============================================================================

/**
 * Ensure project exists for workspace path.
 * Returns the project ID.
 */
export async function ensureProject(gitRepoPath: string): Promise<string> {
  const response = await desktopFetch<{ project: { id: string } }>(
    "/rpc/projects/ensure",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ git_repo_path: gitRepoPath }),
    },
  );
  return response.project.id;
}

/**
 * Update task title.
 * The change will appear in the WebSocket stream automatically.
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

/**
 * Cancel a task run.
 */
export async function cancelTaskRun(runId: string): Promise<void> {
  await desktopFetch(`/rpc/task-runs/${runId}/cancel`, {
    method: "POST",
  });
}
