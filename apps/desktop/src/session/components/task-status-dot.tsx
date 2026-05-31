import type { TaskStatusDotKind } from "../domain/task-read-state";

const DOT_CLASS: Record<NonNullable<TaskStatusDotKind>, string> = {
  // Red: the run crashed / failed (e.g. recovered as failed after the app was
  // closed mid-session).
  failed: "bg-destructive",
  // Blue: the run finished successfully but the user has not opened it yet.
  completed: "bg-[#307BD0]",
};

interface TaskStatusDotProps {
  kind: TaskStatusDotKind;
  label?: string;
}

/**
 * Small dot shown to the left of a session's timestamp to flag an unread
 * terminal result. Renders nothing while running, for non-terminal states, or
 * once the task has been viewed.
 */
export function TaskStatusDot({ kind, label }: TaskStatusDotProps) {
  if (!kind) return null;
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_CLASS[kind]}`}
    />
  );
}
