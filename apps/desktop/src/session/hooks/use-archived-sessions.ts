import { taskApi } from "@/tasks/task-api";
import { useCallback } from "react";
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

/** Minimal slice of `taskApi` the archive flow needs (kept narrow for tests). */
export interface ArchiveTaskApi {
  cancel: (taskId: string) => Promise<void>;
  updateStatus: (taskId: string, status: string) => Promise<void>;
}

/**
 * Archive a session. A session can be archived even while it still reads as
 * "running": an orphaned run whose process already exited (or one stopped
 * mid-turn) keeps `active_session_id` set and its run row stuck on "running",
 * which would otherwise hide the archive control forever. Cancel its run first
 * so the run reaches a terminal status and `active_session_id` is cleared, then
 * archive. The cancel is best-effort — when there is nothing live to cancel it
 * is a harmless no-op, and archiving must still proceed regardless.
 */
export async function archiveTask(
  task: Pick<StoredTask, "id" | "active_session_id">,
  api: ArchiveTaskApi,
): Promise<void> {
  if (task.active_session_id) {
    await api.cancel(task.id).catch(() => {});
  }
  await api.updateStatus(task.id, ARCHIVED_STATUS);
}

export function useArchivedSessions(): UseArchivedSessionsResult {
  const archiveSession = useCallback(
    (task: StoredTask) => archiveTask(task, taskApi),
    [],
  );

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
