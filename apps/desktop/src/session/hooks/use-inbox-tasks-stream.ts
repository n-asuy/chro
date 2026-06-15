/**
 * Hook for streaming tasks across every project via WebSocket.
 *
 * Connects to /streams/tasks with no project filter and receives an initial
 * snapshot of all tasks plus live updates, using the same JSON Patch protocol
 * as the per-project stream. Backs the cross-project inbox, which lists every
 * session ordered by recency rather than grouped by project.
 */
import { getBackendBaseUrl } from "@/lib/backend-client";
import { useCallback, useMemo } from "react";
import type { StoredTask } from "../types";
import { useJsonPatchWsStream } from "./use-json-patch-ws-stream";

export interface UseInboxTasksStreamResult {
  /** Tasks across all projects, most recently updated first. */
  tasks: StoredTask[];
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

type TasksState = {
  tasks: Record<string, StoredTask>;
};

const EMPTY_TASKS_BY_ID: Record<string, StoredTask> = {};

export function useInboxTasksStream(enabled = true): UseInboxTasksStreamResult {
  const endpoint = useMemo(() => {
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    return `${baseUrl}/streams/tasks`;
  }, []);

  const initialData = useCallback((): TasksState => ({ tasks: {} }), []);

  const { data, isConnected, error } = useJsonPatchWsStream<TasksState>(
    endpoint,
    enabled,
    initialData,
  );

  const tasksById = data?.tasks ?? EMPTY_TASKS_BY_ID;

  const tasks = useMemo(
    (): StoredTask[] =>
      Object.values(tasksById).sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      ),
    [tasksById],
  );

  const isLoading = !data && !error;

  return { tasks, isLoading, isConnected, error };
}
