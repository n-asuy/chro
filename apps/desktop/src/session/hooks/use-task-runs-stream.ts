import { getBackendBaseUrl } from "@/lib/backend-client";
/**
 * Hook for streaming task runs via WebSocket.
 *
 * Uses the new /streams/tasks/:task_id/runs endpoint with JSON Patch protocol.
 * Receives initial snapshot + live updates for all runs of a task.
 */
import { useCallback, useMemo } from "react";
import type { TaskRunRecord } from "../types";
import { useJsonPatchWsStream } from "./use-json-patch-ws-stream";

export interface UseTaskRunsStreamResult {
  runs: TaskRunRecord[];
  runsById: Record<string, TaskRunRecord>;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

interface UseTaskRunsStreamParams {
  taskId: string | null;
  enabled?: boolean;
}

type TaskRunsState = {
  task_runs: Record<string, TaskRunRecord>;
};

/**
 * Stream task runs for a specific task via WebSocket.
 *
 * Connects to /streams/tasks/:task_id/runs and receives:
 * - Initial snapshot: { op: "replace", path: "/task_runs", value: {...} }
 * - Live updates: { op: "add/replace/remove", path: "/task_runs/{id}", ... }
 */
export function useTaskRunsStream({
  taskId,
  enabled = true,
}: UseTaskRunsStreamParams): UseTaskRunsStreamResult {
  const endpoint = useMemo(() => {
    if (!taskId) return undefined;
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    return `${baseUrl}/streams/tasks/${encodeURIComponent(taskId)}/runs`;
  }, [taskId]);

  const initialData = useCallback((): TaskRunsState => ({ task_runs: {} }), []);

  const active = enabled && !!taskId;
  const { data, isConnected, error } = useJsonPatchWsStream<TaskRunsState>(
    endpoint,
    active,
    initialData,
  );

  const runsById = useMemo((): Record<string, TaskRunRecord> => {
    if (!taskId) {
      return {};
    }
    const allRuns = data?.task_runs ?? {};
    const filteredRuns = Object.entries(allRuns).filter(
      ([, run]) => run.task_id === taskId,
    );
    return Object.fromEntries(filteredRuns);
  }, [data?.task_runs, taskId]);

  const runs = useMemo((): TaskRunRecord[] => {
    const values: TaskRunRecord[] = Object.values(runsById);
    return values.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
  }, [runsById]);

  // A disabled stream (no task, or not enabled) has nothing to load, so it is
  // never "loading". Reporting `true` here lets `isConversationLoading` —
  // gated on this flag — sit spinning whenever `activeStreamTaskId` is null,
  // which is masked only while the optimistic prompt overlay supplies an entry.
  const isLoading = active && !data && !error;

  return {
    runs,
    runsById,
    isLoading,
    isConnected,
    error,
  };
}
