import { useProjectContext } from "@/files/context/project-context";
import { type ReactNode, createContext, useContext, useMemo } from "react";
import { applyPendingSubmissionsToTasks } from "../domain/session-task-state";
import { useProjectTasksStream } from "../hooks";
import type { UseProjectTasksStreamResult } from "../hooks";
import { usePendingSessionSubmissions } from "../state/pending-session-submissions-store";
import type { StoredTask } from "../types";

interface ProjectTasksContextValue extends UseProjectTasksStreamResult {
  /** Lookup keyed by both task id and slug. */
  taskByKey: Map<string, StoredTask>;
  /** Number of tasks with an active session (currently running). */
  runningCount: number;
  /**
   * The raw stream tasks, WITHOUT the optimistic pending overlay applied.
   * Consumers that decide pending-submission settlement must use this: settling
   * against the overlaid `tasks` lets a pending settle against its own
   * synthesized row, clearing it before the real task reaches the stream.
   */
  rawTasks: StoredTask[];
  /** Raw stream tasks keyed by id (no optimistic overlay). */
  rawTasksById: Record<string, StoredTask>;
}

const ProjectTasksContext = createContext<ProjectTasksContextValue | null>(
  null,
);

/**
 * Hoists a single project-tasks WebSocket subscription so multiple consumers
 * (sidebar list, tab bar, dock badge, title sync) share one stream.
 */
export function ProjectTasksProvider({ children }: { children: ReactNode }) {
  const { projectId } = useProjectContext();
  const rawStream = useProjectTasksStream({
    projectId,
    enabled: Boolean(projectId),
  });
  const pendingSubmissions = usePendingSessionSubmissions(
    projectId,
    rawStream.tasksById,
  );
  const tasks = useMemo(
    () =>
      applyPendingSubmissionsToTasks(
        rawStream.tasks,
        pendingSubmissions,
        projectId,
      ),
    [pendingSubmissions, projectId, rawStream.tasks],
  );
  const tasksById = useMemo(
    () =>
      Object.fromEntries(tasks.map((task) => [task.id, task])) as Record<
        string,
        StoredTask
      >,
    [tasks],
  );
  const stream = useMemo<UseProjectTasksStreamResult>(
    () => ({ ...rawStream, tasks, tasksById }),
    [rawStream, tasks, tasksById],
  );

  const taskByKey = useMemo(() => {
    const map = new Map<string, StoredTask>();
    for (const task of tasks) {
      map.set(task.id, task);
      if (task.slug) map.set(task.slug, task);
    }
    return map;
  }, [tasks]);

  const runningCount = useMemo(
    () => tasks.reduce((n, task) => n + (task.active_session_id ? 1 : 0), 0),
    [tasks],
  );

  const value = useMemo<ProjectTasksContextValue>(
    () => ({
      ...stream,
      taskByKey,
      runningCount,
      rawTasks: rawStream.tasks,
      rawTasksById: rawStream.tasksById,
    }),
    [stream, taskByKey, runningCount, rawStream.tasks, rawStream.tasksById],
  );

  return (
    <ProjectTasksContext.Provider value={value}>
      {children}
    </ProjectTasksContext.Provider>
  );
}

export function useProjectTasks(): ProjectTasksContextValue {
  const ctx = useContext(ProjectTasksContext);
  if (!ctx) {
    throw new Error(
      "useProjectTasks must be used within <ProjectTasksProvider>",
    );
  }
  return ctx;
}

export function useOptionalProjectTasks(): ProjectTasksContextValue | null {
  return useContext(ProjectTasksContext);
}
