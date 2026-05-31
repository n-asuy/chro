import { useMemo } from "react";
import { create } from "zustand";
import type { StoredTask } from "../types";

type TaskTitleOverride = {
  projectId: string;
  title: string;
};

interface TaskTitleOverridesStore {
  overridesByTaskId: Record<string, TaskTitleOverride>;
  setTaskTitleOverride: (
    task: Pick<StoredTask, "id" | "project_id" | "title">,
  ) => void;
  clearTaskTitleOverride: (taskId: string, title?: string) => void;
}

export const useTaskTitleOverridesStore = create<TaskTitleOverridesStore>()(
  (set) => ({
    overridesByTaskId: {},
    setTaskTitleOverride: (task) => {
      set((state) => ({
        overridesByTaskId: {
          ...state.overridesByTaskId,
          [task.id]: {
            projectId: task.project_id,
            title: task.title,
          },
        },
      }));
    },
    clearTaskTitleOverride: (taskId, title) => {
      set((state) => {
        const current = state.overridesByTaskId[taskId];
        if (!current || (title !== undefined && current.title !== title)) {
          return state;
        }

        const next = { ...state.overridesByTaskId };
        delete next[taskId];
        return { overridesByTaskId: next };
      });
    },
  }),
);

export function useTaskTitleOverrides(
  projectId: string | null,
): Record<string, string> {
  const overridesByTaskId = useTaskTitleOverridesStore(
    (state) => state.overridesByTaskId,
  );

  return useMemo(() => {
    if (!projectId) {
      return {};
    }

    const titles: Record<string, string> = {};
    for (const [taskId, override] of Object.entries(overridesByTaskId)) {
      if (override.projectId === projectId) {
        titles[taskId] = override.title;
      }
    }
    return titles;
  }, [overridesByTaskId, projectId]);
}

export function applyTaskTitleOverridesToTasksById(
  tasksById: Record<string, StoredTask>,
  titleOverrides: Record<string, string>,
): Record<string, StoredTask> {
  let next: Record<string, StoredTask> | null = null;

  for (const [taskId, title] of Object.entries(titleOverrides)) {
    const task = tasksById[taskId];
    if (!task || task.title === title) {
      continue;
    }

    next ??= { ...tasksById };
    next[taskId] = { ...task, title };
  }

  return next ?? tasksById;
}
