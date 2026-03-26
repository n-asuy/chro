/**
 * Task runs store - DEPRECATED
 *
 * This store is kept for backward compatibility but should be migrated to
 * useTaskRunsStream hook which uses WebSocket for real-time updates.
 *
 * @deprecated Use useTaskRunsStream from @/session/hooks instead
 */
import { create } from "zustand";
import { desktopFetch } from "@/lib/backend-client";
import type { TaskRunRecord } from "@/session/types";

const CANCELABLE_STATUSES = new Set(["running", "pending"]);

type TaskRunsState = {
  /** Map of taskId -> runs */
  runsByTaskId: Record<string, TaskRunRecord[]>;
  /** Set of taskIds currently being fetched */
  loadingTaskIds: Set<string>;
  /** Global error message */
  error: string | null;
};

type TaskRunsActions = {
  /** @deprecated Use useTaskRunsStream hook instead */
  loadRunsForTask: (taskId: string) => Promise<TaskRunRecord[]>;
  /** @deprecated Use useTaskRunsStream hook instead */
  loadRunsForTasks: (taskIds: string[]) => Promise<void>;
  cancelRun: (runId: string, taskId: string) => Promise<void>;
  getCancelableRunId: (taskId: string) => string | null;
  hasActiveRun: (taskId: string) => boolean;
  clearRuns: () => void;
};

type TaskRunsStore = TaskRunsState & TaskRunsActions;

const findCancelableRunId = (runs: TaskRunRecord[]): string | null => {
  const match = runs.find((run) => CANCELABLE_STATUSES.has(run.status));
  return match?.id ?? null;
};

/**
 * @deprecated Use useTaskRunsStream hook for real-time WebSocket updates
 */
export const useTaskRunsStore = create<TaskRunsStore>((set, get) => ({
  runsByTaskId: {},
  loadingTaskIds: new Set(),
  error: null,

  loadRunsForTask: async (taskId: string) => {
    const state = get();
    if (state.loadingTaskIds.has(taskId)) {
      return state.runsByTaskId[taskId] ?? [];
    }

    set({ loadingTaskIds: new Set([...state.loadingTaskIds, taskId]) });

    try {
      const response = await desktopFetch<{ runs: TaskRunRecord[] }>(
        `/rpc/tasks/${taskId}/runs`,
      );
      const runs = response.runs ?? [];

      set((s) => {
        const newLoadingIds = new Set(s.loadingTaskIds);
        newLoadingIds.delete(taskId);
        return {
          runsByTaskId: { ...s.runsByTaskId, [taskId]: runs },
          loadingTaskIds: newLoadingIds,
          error: null,
        };
      });

      return runs;
    } catch (error) {
      set((s) => {
        const newLoadingIds = new Set(s.loadingTaskIds);
        newLoadingIds.delete(taskId);
        return {
          loadingTaskIds: newLoadingIds,
          error: error instanceof Error ? error.message : "Failed to load runs",
        };
      });
      return [];
    }
  },

  loadRunsForTasks: async (taskIds: string[]) => {
    const uniqueIds = [...new Set(taskIds)];
    await Promise.all(uniqueIds.map((id) => get().loadRunsForTask(id)));
  },

  cancelRun: async (runId: string, taskId: string) => {
    try {
      await desktopFetch(`/rpc/task-runs/${runId}/cancel`, { method: "POST" });
      // With WebSocket, the runs will update automatically via the stream
      // Optionally reload if not using WebSocket
      await get().loadRunsForTask(taskId);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "Failed to cancel run",
      });
      throw error;
    }
  },

  getCancelableRunId: (taskId: string) => {
    const runs = get().runsByTaskId[taskId] ?? [];
    return findCancelableRunId(runs);
  },

  hasActiveRun: (taskId: string) => {
    return get().getCancelableRunId(taskId) !== null;
  },

  clearRuns: () => {
    set({ runsByTaskId: {}, loadingTaskIds: new Set(), error: null });
  },
}));

// =============================================================================
// Standalone API functions for mutations
// =============================================================================

/**
 * Cancel a task run.
 * The status change will appear in the WebSocket stream automatically.
 */
export async function cancelTaskRun(runId: string): Promise<void> {
  await desktopFetch(`/rpc/task-runs/${runId}/cancel`, { method: "POST" });
}
