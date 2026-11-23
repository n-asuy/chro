import { type TaskIconName, taskIconPath } from "../domain/task-icons";

/** A session's icon: one thin line drawing on the 24-unit grid. */
export function EdgeTaskIcon({ name }: { name: TaskIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="edge-task-icon"
    >
      <path d={taskIconPath(name)} />
    </svg>
  );
}
