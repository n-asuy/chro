import { useEffect } from "react";
import {
  type TaskStatusDotKind,
  deriveTaskStatusDot,
} from "../domain/task-read-state";
import { useSessionReadStore } from "../state/session-read-store";
import type { StoredTask } from "../types";

type TaskDotFields = Pick<
  StoredTask,
  "id" | "status" | "active_session_id" | "updated_at"
>;

/**
 * Hydrate the session read-state store once UI state is available. Mount once
 * high in the shell; `loadUiState()` resolves async, so the first attempt
 * usually sees an empty cache — poll every 50ms until hydration succeeds.
 */
export function useSessionReadSync(): void {
  const hydrate = useSessionReadStore((s) => s.hydrate);
  useEffect(() => {
    if (hydrate()) return;
    const id = window.setInterval(() => {
      if (hydrate()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [hydrate]);
}

/** The unread status dot for a task, reactive to view marks. */
export function useTaskStatusDot(task: TaskDotFields): TaskStatusDotKind {
  const lastViewedAt = useSessionReadStore((s) => s.viewedAt[task.id]);
  return deriveTaskStatusDot(task, lastViewedAt);
}

/**
 * Mark a task viewed while it is the active (open) row and in a terminal
 * state. Covers both opening an unread task and a task finishing while it is
 * already open — either way its dot clears once the user can see the result.
 */
export function useMarkViewedWhenActive(
  task: TaskDotFields,
  isActive: boolean,
): void {
  const markViewed = useSessionReadStore((s) => s.markViewed);
  const isTerminal =
    !task.active_session_id &&
    (task.status === "completed" || task.status === "failed");
  useEffect(() => {
    if (isActive && isTerminal) markViewed(task.id);
  }, [isActive, isTerminal, task.id, task.updated_at, markViewed]);
}
