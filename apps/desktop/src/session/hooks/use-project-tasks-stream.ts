/**
 * Hook for streaming project tasks via WebSocket.
 *
 * Uses the new /streams/tasks endpoint with JSON Patch protocol.
 * Receives initial snapshot + live updates for all tasks in a project.
 */
import { useMemo, useCallback } from "react";
import { getBackendBaseUrl } from "@/lib/backend-client";
import type { StoredTask } from "../types";
import { useJsonPatchWsStream } from "./use-json-patch-ws-stream";

export interface UseProjectTasksStreamResult {
  tasks: StoredTask[];
  tasksById: Record<string, StoredTask>;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

interface UseProjectTasksStreamParams {
  projectId: string | null;
  enabled?: boolean;
}

type TasksState = {
  tasks: Record<string, StoredTask>;
};

/**
 * Stream tasks for a project via WebSocket.
 *
 * Connects to /streams/tasks?project_id=... and receives:
 * - Initial snapshot: { op: "replace", path: "/tasks", value: {...} }
 * - Live updates: { op: "add/replace/remove", path: "/tasks/{id}", ... }
 */
export function useProjectTasksStream({
  projectId,
  enabled = true,
}: UseProjectTasksStreamParams): UseProjectTasksStreamResult {
  const endpoint = useMemo(() => {
    if (!projectId) return undefined;
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    return `${baseUrl}/streams/tasks?project_id=${encodeURIComponent(projectId)}`;
  }, [projectId]);

  const initialData = useCallback((): TasksState => ({ tasks: {} }), []);

  const { data, isConnected, error } = useJsonPatchWsStream<TasksState>(
    endpoint,
    enabled && !!projectId,
    initialData,
  );

  const tasksById = useMemo(
    (): Record<string, StoredTask> => data?.tasks ?? {},
    [data?.tasks],
  );

  const tasks = useMemo((): StoredTask[] => {
    const values: StoredTask[] = Object.values(tasksById);
    return values.sort((a, b) => {
      const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    });
  }, [tasksById]);

  const isLoading = !data && !error;

  return {
    tasks,
    tasksById,
    isLoading,
    isConnected,
    error,
  };
}
