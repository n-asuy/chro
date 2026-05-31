
import { useCallback } from "react";
import { taskApi } from "@/tasks/task-api";
import type { StoredTask } from "../types";

// Backend uses "cancelled" for archived tasks
const ARCHIVED_STATUS = "cancelled";

export interface ArchivedSession {
  id: string;
  title: string | null;
  archivedAt: string;
}

export interface UseArchivedSessionsResult {
  archiveSession: (task: StoredTask) => Promise<void>;
  restoreSession: (taskId: string) => Promise<void>;
  isArchived: (task: StoredTask) => boolean;
}

export function useArchivedSessions(): UseArchivedSessionsResult {
  const archiveSession = useCallback(async (task: StoredTask) => {
    await taskApi.updateStatus(task.id, ARCHIVED_STATUS);
  }, []);

  const restoreSession = useCallback(async (taskId: string) => {
    // Restore to "pending" status (initial task state)
    await taskApi.updateStatus(taskId, "pending");
  }, []);

  const isArchived = useCallback((task: StoredTask) => {
    return task.status === ARCHIVED_STATUS;
  }, []);

  return {
    archiveSession,
    restoreSession,
    isArchived,
  };
}
