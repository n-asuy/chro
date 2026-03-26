/**
 * Hook for streaming task drafts via WebSocket.
 *
 * Uses the new /streams/task-drafts endpoint with JSON Patch protocol.
 * Receives initial snapshot + live updates for all drafts in a project.
 */
import { useMemo, useCallback } from "react";
import { getBackendBaseUrl } from "@/lib/backend-client";
import { useJsonPatchWsStream } from "./use-json-patch-ws-stream";

export type DraftType = "initial" | "retry" | "follow_up";

export interface TaskDraft {
  id: string;
  task_id: string;
  retry_task_run_id: string | null;
  draft_type: DraftType;
  prompt: string | null;
  image_ids: string | null;
  queued: boolean;
  sending: boolean;
  version: number;
  variant: string | null;
  created_at: string;
  updated_at: string;
}

export interface UseTaskDraftsStreamResult {
  drafts: TaskDraft[];
  draftsById: Record<string, TaskDraft>;
  /** Get drafts for a specific task */
  getDraftsForTask: (taskId: string) => TaskDraft[];
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

interface UseTaskDraftsStreamParams {
  projectId: string | null;
  enabled?: boolean;
}

type TaskDraftsState = {
  task_drafts: Record<string, TaskDraft>;
};

/**
 * Stream task drafts for a project via WebSocket.
 *
 * Connects to /streams/task-drafts?project_id=... and receives:
 * - Initial snapshot: { op: "replace", path: "/task_drafts", value: {...} }
 * - Live updates: { op: "add/replace/remove", path: "/task_drafts/{id}", ... }
 */
export function useTaskDraftsStream({
  projectId,
  enabled = true,
}: UseTaskDraftsStreamParams): UseTaskDraftsStreamResult {
  const endpoint = useMemo(() => {
    if (!projectId) return undefined;
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    return `${baseUrl}/streams/task-drafts?project_id=${encodeURIComponent(projectId)}`;
  }, [projectId]);

  const initialData = useCallback(
    (): TaskDraftsState => ({ task_drafts: {} }),
    [],
  );

  const { data, isConnected, error } = useJsonPatchWsStream<TaskDraftsState>(
    endpoint,
    enabled && !!projectId,
    initialData,
  );

  const draftsById = useMemo(
    (): Record<string, TaskDraft> => data?.task_drafts ?? {},
    [data?.task_drafts],
  );

  const drafts = useMemo((): TaskDraft[] => {
    const values: TaskDraft[] = Object.values(draftsById);
    return values.sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }, [draftsById]);

  const getDraftsForTask = useCallback(
    (taskId: string): TaskDraft[] => {
      return drafts.filter((draft) => draft.task_id === taskId);
    },
    [drafts],
  );

  const isLoading = !data && !error;

  return {
    drafts,
    draftsById,
    getDraftsForTask,
    isLoading,
    isConnected,
    error,
  };
}
