/**
 * Hook for workspace board management with WebSocket-backed data.
 *
 * Replaces the REST-based workspace-store with WebSocket streaming.
 * Uses useProjectTasksStream for real-time task updates and provides
 * optimistic UI mutations.
 */
import { useCallback, useMemo, useState, useRef, useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  BoardColumn,
  BoardFilterKey,
  BoardFilters,
  BoardIssue,
  IssueLabel,
  IssueMember,
  IssueState,
  WorkspaceMeta,
} from "@/kanban/types";
import {
  COLUMN_DEFINITIONS,
  columnIdToStatus,
  statusToColumnId,
  formatTaskKey,
  tasksToBoardColumns,
  type TaskRecord,
  type TaskStatus,
} from "../state/task-store";
import { taskApi } from "../api/task-api";
import { useProjectTasksStream } from "@/session/hooks/use-project-tasks-stream";
import type { StoredTask } from "@/session/types";
import type { ExecutorProfileId } from "@/lib/executor-client";

/**
 * Convert StoredTask (from WebSocket) to TaskRecord (for board)
 */
const storedTaskToTaskRecord = (task: StoredTask): TaskRecord => ({
  id: task.id,
  project_id: task.project_id,
  parent_task_id: null,
  title: task.title,
  description: task.description ?? null,
  status: task.status as TaskStatus,
  due_at: null,
  branch: task.branch ?? null,
  worktree_path: null,
  worktree_deleted: false,
  active_session_id: task.active_session_id ?? null,
  created_at: task.created_at,
  updated_at: task.updated_at,
  sort_order: task.sort_order ?? 0,
});

const COLUMN_PAGE_SIZE = 6;

/**
 * Default workspace metadata
 */
const defaultWorkspaceMeta: WorkspaceMeta = {
  name: "Workspace",
  slug: "tasks",
  projectId: "",
  projectName: "Tasks",
  projectIdentifier: "TASK",
};

/**
 * Default board filters
 */
const defaultFilters: BoardFilters = {
  state: [],
  priority: [],
  labels: [],
};

/**
 * Default state options based on column definitions
 */
const defaultStateOptions: IssueState[] = COLUMN_DEFINITIONS.map(
  (def) => def.state,
);

/**
 * Default empty options (no labels or members in task model)
 */
const defaultLabelOptions: IssueLabel[] = [];
const defaultMembers: IssueMember[] = [];

const initializeColumnIssueIds = (columns: BoardColumn[]) =>
  columns.reduce<Record<string, string[]>>((acc, column) => {
    acc[column.id] = column.issues
      .slice(0, COLUMN_PAGE_SIZE)
      .map((issue) => issue.id);
    return acc;
  }, {});

const initializePaginationFlags = (columns: BoardColumn[]) =>
  columns.reduce<Record<string, boolean>>((acc, column) => {
    acc[column.id] = false;
    return acc;
  }, {});

const getMaxSequenceId = (columns: BoardColumn[]) =>
  columns.reduce((max, column) => {
    const columnMax = column.issues.reduce(
      (colMax, issue) => Math.max(colMax, issue.sequenceId),
      0,
    );
    return Math.max(max, columnMax);
  }, 0);

const createIssueForColumn = (
  column: BoardColumn,
  workspaceMeta: WorkspaceMeta,
  sequenceId: number,
  payload: { title: string; summary?: string },
): BoardIssue => {
  const { title, summary } = payload;
  const columnDef = COLUMN_DEFINITIONS.find((def) => def.id === column.id);
  const now = new Date().toISOString();

  return {
    id: `temp-issue-${sequenceId}`,
    sequenceId,
    key: formatTaskKey(undefined, sequenceId),
    title,
    summary: summary ?? "",
    description: summary ?? "",
    branch: null,
    activeSessionId: null,
    priority: "medium",
    state: columnDef?.state ?? defaultStateOptions[0],
    labels: [],
    startDate: undefined,
    dueDate: undefined,
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
    projectIdentifier: workspaceMeta.projectIdentifier,
    projectName: workspaceMeta.projectName,
    updatedAt: now,
    createdAt: now,
  };
};

/**
 * Optimistic update entry for tracking pending mutations
 */
interface OptimisticUpdate {
  type: "add" | "move" | "delete";
  tempId?: string;
  issueId?: string;
  columnId?: string;
  issue?: BoardIssue;
}

export interface UseWorkspaceBoardParams {
  workspacePath: string | null;
  projectId: string | null;
}

export type AddIssueOptions = {
  summary?: string;
  runImmediately?: boolean;
  useWorktree?: boolean;
  executorProfileId?: ExecutorProfileId | null;
  targetBranch?: string;
};

export interface UseWorkspaceBoardResult {
  workspace: WorkspaceMeta;
  columns: BoardColumn[];
  filters: BoardFilters;
  stateOptions: IssueState[];
  labelOptions: IssueLabel[];
  members: IssueMember[];
  peekIssueId?: string;
  columnVisibleIssueIds: Record<string, string[]>;
  isColumnPaginating: Record<string, boolean>;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;

  // Actions
  setPeekIssue: (id?: string) => void;
  toggleFilter: (key: BoardFilterKey, value: string) => void;
  clearFilters: () => void;
  getIssueById: (id: string | undefined) => BoardIssue | undefined;
  loadMoreIssues: (columnId: string) => void;
  addIssueToColumn: (
    columnId: string,
    title: string,
    options?: AddIssueOptions,
  ) => Promise<void>;
  moveIssue: (payload: {
    issueId: string;
    sourceColumnId: string;
    targetColumnId: string;
    targetIndex?: number;
  }) => Promise<void>;
  deleteIssue: (issueId: string) => Promise<void>;
  deleteArchivedIssues: () => Promise<void>;
}

/**
 * Hook providing workspace board functionality with WebSocket-backed data.
 *
 * Key differences from the Zustand store:
 * - Data comes from WebSocket stream (real-time updates)
 * - Optimistic updates are applied on top of streamed data
 * - No polling or manual refresh needed
 */
export function useWorkspaceBoard({
  workspacePath,
  projectId,
}: UseWorkspaceBoardParams): UseWorkspaceBoardResult {
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { projectId?: string; taskId?: string };
  const routeTaskId = params.taskId ?? undefined;

  // WebSocket stream for tasks
  const {
    tasks,
    isLoading: streamLoading,
    isConnected,
    error: streamError,
  } = useProjectTasksStream({
    projectId,
    enabled: !!projectId,
  });

  // Local UI state
  const [filters, setFilters] = useState<BoardFilters>(defaultFilters);
  // peekIssueId is derived from URL
  const [peekIssueId, setPeekIssueId] = useState<string | undefined>(routeTaskId);
  const [optimisticUpdates, setOptimisticUpdates] = useState<
    OptimisticUpdate[]
  >([]);
  const [columnVisibleIssueIds, setColumnVisibleIssueIds] = useState<
    Record<string, string[]>
  >({});
  const [isColumnPaginating, setIsColumnPaginating] = useState<
    Record<string, boolean>
  >({});

  // Sequence ID counter for temporary issues
  const sequenceIdRef = useRef(0);

  // Convert tasks to columns with optimistic updates applied
  const columns = useMemo(() => {
    const taskRecords = tasks.map(storedTaskToTaskRecord);
    const baseColumns = tasksToBoardColumns(taskRecords);

    // Update sequence ID counter
    const maxSeq = getMaxSequenceId(baseColumns);
    if (maxSeq > sequenceIdRef.current) {
      sequenceIdRef.current = maxSeq;
    }

    // Apply optimistic updates
    let result = baseColumns;

    for (const update of optimisticUpdates) {
      switch (update.type) {
        case "add":
          if (update.columnId && update.issue) {
            result = result.map((col) =>
              col.id === update.columnId
                ? { ...col, issues: [update.issue!, ...col.issues] }
                : col,
            );
          }
          break;
        case "delete":
          if (update.issueId) {
            result = result.map((col) => ({
              ...col,
              issues: col.issues.filter((issue) => issue.id !== update.issueId),
            }));
          }
          break;
        case "move":
          // Move is handled by the backend via status update
          // The WebSocket stream will reflect the change
          break;
      }
    }

    return result;
  }, [tasks, optimisticUpdates]);

  // Update visible issue IDs when columns change
  useEffect(() => {
    setColumnVisibleIssueIds((prev) => {
      const next: Record<string, string[]> = {};
      let hasChanges = false;

      for (const column of columns) {
        const existingIds = prev[column.id];
        let newIds: string[];

        if (existingIds && existingIds.length > 0) {
          // Keep existing pagination state, but sync with actual issues
          newIds = column.issues
            .slice(0, Math.max(existingIds.length, COLUMN_PAGE_SIZE))
            .map((issue) => issue.id);
        } else {
          newIds = column.issues
            .slice(0, COLUMN_PAGE_SIZE)
            .map((issue) => issue.id);
        }

        next[column.id] = newIds;

        // Check if this column's IDs changed
        if (
          !existingIds ||
          existingIds.length !== newIds.length ||
          existingIds.some((id, i) => id !== newIds[i])
        ) {
          hasChanges = true;
        }
      }

      // Check if any columns were removed
      const prevColumnIds = Object.keys(prev);
      const nextColumnIds = Object.keys(next);
      if (
        prevColumnIds.length !== nextColumnIds.length ||
        prevColumnIds.some((id) => !next[id])
      ) {
        hasChanges = true;
      }

      // Only return new object if there are actual changes
      return hasChanges ? next : prev;
    });
  }, [columns]);

  // Initialize pagination flags
  useEffect(() => {
    setIsColumnPaginating((prev) => {
      const next: Record<string, boolean> = {};
      let hasChanges = false;

      for (const column of columns) {
        const existingValue = prev[column.id];
        const newValue = existingValue ?? false;
        next[column.id] = newValue;

        if (existingValue === undefined) {
          hasChanges = true;
        }
      }

      // Check if any columns were removed
      const prevColumnIds = Object.keys(prev);
      if (prevColumnIds.some((id) => !columns.some((col) => col.id === id))) {
        hasChanges = true;
      }

      return hasChanges ? next : prev;
    });
  }, [columns]);

  // Remove optimistic updates when real data arrives
  useEffect(() => {
    setOptimisticUpdates((prev) => {
      if (prev.length === 0) return prev;

      const next = prev.filter((update) => {
        if (update.type === "add" && update.tempId) {
          // Check if the real task has arrived (by checking if temp ID still exists)
          const tempExists = columns.some((col) =>
            col.issues.some((issue) => issue.id === update.tempId),
          );
          // If temp ID is gone but we're still tracking it, the real task arrived
          // Actually, we need to track the real ID to remove the optimistic update
          // For now, keep simple: remove add updates after 30 seconds
          return true; // Keep for now, remove when replaced with real ID
        }
        if (update.type === "delete" && update.issueId) {
          // Remove delete updates once the issue is gone from the stream
          const stillExists = columns.some((col) =>
            col.issues.some((issue) => issue.id === update.issueId),
          );
          return stillExists; // Keep if still visible (pending deletion)
        }
        return true;
      });

      // Only update if array length changed (filter removed items)
      return next.length !== prev.length ? next : prev;
    });
  }, [columns]);

  const workspace = useMemo(
    (): WorkspaceMeta => ({
      ...defaultWorkspaceMeta,
      projectId: projectId ?? "",
    }),
    [projectId],
  );

  // Sync peekIssueId with URL param
  useEffect(() => {
    setPeekIssueId(routeTaskId);
  }, [routeTaskId]);

  const setPeekIssue = useCallback(
    (id?: string) => {
      setPeekIssueId(id);
      // Update URL to reflect the selected task
      if (!projectId) return;
      if (id) {
        void navigate({ to: `/projects/${projectId}/tasks/${id}` });
      } else {
        void navigate({ to: `/projects/${projectId}/tasks` });
      }
    },
    [projectId, navigate],
  );

  const toggleFilter = useCallback((key: BoardFilterKey, value: string) => {
    setFilters((prev) => {
      const current = prev[key] as string[];
      const exists = current.includes(value);
      const updated = exists
        ? current.filter((item) => item !== value)
        : [...current, value];
      return { ...prev, [key]: updated } as BoardFilters;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setFilters((prev) => ({ ...prev, state: [], priority: [], labels: [] }));
  }, []);

  const getIssueById = useCallback(
    (id: string | undefined): BoardIssue | undefined => {
      if (!id) return undefined;
      for (const column of columns) {
        const match = column.issues.find((issue) => issue.id === id);
        if (match) return match;
      }
      return undefined;
    },
    [columns],
  );

  const loadMoreIssues = useCallback(
    (columnId: string) => {
      const column = columns.find((col) => col.id === columnId);
      if (!column) return;

      const currentIds = columnVisibleIssueIds[columnId] ?? [];
      if (
        isColumnPaginating[columnId] ||
        currentIds.length >= column.issues.length
      ) {
        return;
      }

      setIsColumnPaginating((prev) => ({ ...prev, [columnId]: true }));

      setTimeout(() => {
        setColumnVisibleIssueIds((prev) => {
          const loadedIds = prev[columnId] ?? [];
          const col = columns.find((c) => c.id === columnId);
          if (!col) return prev;

          const nextIds = col.issues
            .slice(0, loadedIds.length + COLUMN_PAGE_SIZE)
            .map((issue) => issue.id);
          return { ...prev, [columnId]: nextIds };
        });
        setIsColumnPaginating((prev) => ({ ...prev, [columnId]: false }));
      }, 600);
    },
    [columns, columnVisibleIssueIds, isColumnPaginating],
  );

  const addIssueToColumn = useCallback(
    async (columnId: string, title: string, options?: AddIssueOptions) => {
      const trimmedTitle = title.trim();
      if (!trimmedTitle || !workspacePath) return;

      const summaryValue = options?.summary?.trim();
      const normalizedSummary =
        summaryValue && summaryValue.length > 0 ? summaryValue : undefined;
      const runImmediately = options?.runImmediately ?? true;
      const useWorktree = options?.useWorktree ?? true;
      const executorProfileId = options?.executorProfileId ?? undefined;

      const column = columns.find((col) => col.id === columnId);
      if (!column) return;

      // Create optimistic issue
      const nextSeqId = ++sequenceIdRef.current;
      const tempIssue = createIssueForColumn(column, workspace, nextSeqId, {
        title: trimmedTitle,
        summary: normalizedSummary,
      });

      // Add optimistic update
      const optimisticUpdate: OptimisticUpdate = {
        type: "add",
        tempId: tempIssue.id,
        columnId,
        issue: tempIssue,
      };

      setOptimisticUpdates((prev) => [...prev, optimisticUpdate]);
      setColumnVisibleIssueIds((prev) => ({
        ...prev,
        [columnId]: [tempIssue.id, ...(prev[columnId] ?? [])],
      }));

      try {
        const resolvedProjectId = await taskApi.ensureProject(workspacePath);
        const savedTask = await taskApi.create(
          resolvedProjectId,
          trimmedTitle,
          normalizedSummary ?? null,
        );

        // Remove optimistic update (WebSocket will bring the real data)
        setOptimisticUpdates((prev) =>
          prev.filter((u) => u.tempId !== tempIssue.id),
        );

        // Update visible IDs to use real ID
        setColumnVisibleIssueIds((prev) => ({
          ...prev,
          [columnId]: (prev[columnId] ?? []).map((id) =>
            id === tempIssue.id ? savedTask.id : id,
          ),
        }));

        // Start agent if requested
        if (runImmediately) {
          try {
            await taskApi.startClaudeExecution(workspacePath, savedTask.id, {
              useWorktree,
              executorProfileId,
              targetBranch: options?.targetBranch,
            });
          } catch (error) {
            console.error("Failed to start agent for task:", error);
          }
        }
      } catch (error) {
        console.error("Failed to create task:", error);
        // Rollback optimistic update
        setOptimisticUpdates((prev) =>
          prev.filter((u) => u.tempId !== tempIssue.id),
        );
        setColumnVisibleIssueIds((prev) => ({
          ...prev,
          [columnId]: (prev[columnId] ?? []).filter(
            (id) => id !== tempIssue.id,
          ),
        }));
      }
    },
    [workspacePath, columns, workspace],
  );

  const moveIssue = useCallback(
    async ({
      issueId,
      sourceColumnId,
      targetColumnId,
      targetIndex,
    }: {
      issueId: string;
      sourceColumnId: string;
      targetColumnId: string;
      targetIndex?: number;
    }) => {
      if (!issueId || !sourceColumnId || !targetColumnId) return;

      // Build task ID lists per column from current tasks
      const tasksByColumn = new Map<string, string[]>();
      for (const task of tasks) {
        const colId = statusToColumnId(task.status as TaskStatus);
        const list = tasksByColumn.get(colId) ?? [];
        list.push(task.id);
        tasksByColumn.set(colId, list);
      }

      // Remove issue from source column
      const sourceIds = tasksByColumn.get(sourceColumnId) ?? [];
      const filtered = sourceIds.filter((id) => id !== issueId);
      tasksByColumn.set(sourceColumnId, filtered);

      // Insert into target column at the target index
      const targetIds = tasksByColumn.get(targetColumnId) ?? [];
      const insertAt =
        targetIndex !== undefined
          ? Math.min(targetIndex, targetIds.length)
          : targetIds.length;
      targetIds.splice(insertAt, 0, issueId);
      tasksByColumn.set(targetColumnId, targetIds);

      // Compute new sort_order for affected columns
      const reorderUpdates: Array<{ id: string; sort_order: number }> = [];
      const affectedColumns = new Set([sourceColumnId, targetColumnId]);
      for (const colId of affectedColumns) {
        const ids = tasksByColumn.get(colId) ?? [];
        for (let i = 0; i < ids.length; i++) {
          reorderUpdates.push({ id: ids[i], sort_order: i + 1 });
        }
      }

      // Update status if column changed
      if (sourceColumnId !== targetColumnId) {
        const newStatus = columnIdToStatus(targetColumnId);
        try {
          await taskApi.updateStatus(issueId, newStatus);
        } catch (error) {
          console.error("Failed to update task status:", error);
        }
      }

      // Persist sort order
      try {
        await taskApi.reorder(reorderUpdates);
      } catch (error) {
        console.error("Failed to persist sort order:", error);
      }
    },
    [tasks],
  );

  const deleteIssue = useCallback(
    async (issueId: string) => {
      const targetColumn = columns.find((column) =>
        column.issues.some((issue) => issue.id === issueId),
      );

      if (!targetColumn) {
        console.warn(
          "[useWorkspaceBoard] deleteIssue: issue not found",
          issueId,
        );
        return;
      }

      // Clear peek if deleting peeked issue
      if (peekIssueId === issueId) {
        setPeekIssueId(undefined);
      }

      const isTemporaryIssue = issueId.startsWith("temp-issue-");
      if (isTemporaryIssue) {
        // Just remove optimistic update
        setOptimisticUpdates((prev) =>
          prev.filter((u) => u.tempId !== issueId),
        );
        return;
      }

      // Add optimistic delete
      const optimisticUpdate: OptimisticUpdate = {
        type: "delete",
        issueId,
      };
      setOptimisticUpdates((prev) => [...prev, optimisticUpdate]);

      try {
        await taskApi.delete(issueId);
        // WebSocket will remove the issue; optimistic update will be cleaned up
      } catch (error) {
        console.error("Failed to delete task:", error);
        // Rollback optimistic delete
        setOptimisticUpdates((prev) =>
          prev.filter((u) => !(u.type === "delete" && u.issueId === issueId)),
        );
        throw error;
      }
    },
    [columns, peekIssueId],
  );

  const deleteArchivedIssues = useCallback(async () => {
    const archivedColumn = columns.find((col) => col.id === "archived");
    if (!archivedColumn || archivedColumn.issues.length === 0) {
      return;
    }

    const issueIds = archivedColumn.issues
      .filter((issue) => !issue.id.startsWith("temp-issue-"))
      .map((issue) => issue.id);

    if (issueIds.length === 0) {
      return;
    }

    // Clear peek if deleting peeked issue
    if (peekIssueId && issueIds.includes(peekIssueId)) {
      setPeekIssueId(undefined);
    }

    // Add optimistic deletes for all archived issues
    const optimisticUpdates: OptimisticUpdate[] = issueIds.map((issueId) => ({
      type: "delete" as const,
      issueId,
    }));
    setOptimisticUpdates((prev) => [...prev, ...optimisticUpdates]);

    // Delete all in parallel
    const results = await Promise.allSettled(
      issueIds.map((issueId) => taskApi.delete(issueId)),
    );

    // Rollback failed deletes
    const failedIds: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error("Failed to delete archived task:", result.reason);
        failedIds.push(issueIds[index]);
      }
    });

    if (failedIds.length > 0) {
      setOptimisticUpdates((prev) =>
        prev.filter(
          (u) => !(u.type === "delete" && failedIds.includes(u.issueId ?? "")),
        ),
      );
    }
  }, [columns, peekIssueId]);

  return {
    workspace,
    columns,
    filters,
    stateOptions: defaultStateOptions,
    labelOptions: defaultLabelOptions,
    members: defaultMembers,
    peekIssueId,
    columnVisibleIssueIds,
    isColumnPaginating,
    isLoading: streamLoading,
    isConnected,
    error: streamError,

    setPeekIssue,
    toggleFilter,
    clearFilters,
    getIssueById,
    loadMoreIssues,
    addIssueToColumn,
    moveIssue,
    deleteIssue,
    deleteArchivedIssues,
  };
}
