import { getBackendBaseUrl } from "@/lib/backend-client";
import { useCallback, useMemo } from "react";
import type { TaskSessionRecord } from "../types";
import { useJsonPatchWsStream } from "./use-json-patch-ws-stream";

export interface UseTaskSessionsStreamResult {
  sessions: TaskSessionRecord[];
  sessionsById: Record<string, TaskSessionRecord>;
  sessionsByRunId: Record<string, TaskSessionRecord>;
  isLoading: boolean;
  isConnected: boolean;
  error: string | null;
}

interface UseTaskSessionsStreamParams {
  taskId: string | null;
  enabled?: boolean;
}

type TaskSessionsState = {
  task_sessions: Record<string, TaskSessionRecord>;
};

export function useTaskSessionsStream({
  taskId,
  enabled = true,
}: UseTaskSessionsStreamParams): UseTaskSessionsStreamResult {
  const endpoint = useMemo(() => {
    if (!taskId) return undefined;
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    return `${baseUrl}/streams/tasks/${encodeURIComponent(taskId)}/sessions`;
  }, [taskId]);

  const initialData = useCallback(
    (): TaskSessionsState => ({ task_sessions: {} }),
    [],
  );

  const { data, isConnected, error } = useJsonPatchWsStream<TaskSessionsState>(
    endpoint,
    enabled && !!taskId,
    initialData,
  );

  const sessionsById = useMemo((): Record<string, TaskSessionRecord> => {
    if (!taskId) {
      return {};
    }
    const allSessions = data?.task_sessions ?? {};
    const filteredSessions = Object.entries(allSessions).filter(
      ([, session]) => session.task_id === taskId,
    );
    return Object.fromEntries(filteredSessions);
  }, [data?.task_sessions, taskId]);

  const sessions = useMemo((): TaskSessionRecord[] => {
    const values = Object.values(sessionsById);
    return values.sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
  }, [sessionsById]);

  const sessionsByRunId = useMemo((): Record<string, TaskSessionRecord> => {
    const result: Record<string, TaskSessionRecord> = {};
    for (const session of sessions) {
      if (!session.task_run_id) continue;
      result[session.task_run_id] = session;
    }
    return result;
  }, [sessions]);

  const isLoading = !data && !error;

  return {
    sessions,
    sessionsById,
    sessionsByRunId,
    isLoading,
    isConnected,
    error,
  };
}
