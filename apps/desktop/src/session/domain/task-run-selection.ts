import type { TaskAttempt } from "../types";
import type { TaskRunRecord } from "../types";

const toTaskAttemptStatus = (
  status: string,
): TaskAttempt["status"] => {
  if (
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "killed"
  ) {
    return status;
  }
  return "failed";
};

export const selectTargetTaskRun = (
  runs: TaskRunRecord[],
  selectedRunId?: string,
): TaskRunRecord | null => {
  if (runs.length === 0) {
    return null;
  }

  if (selectedRunId) {
    return (
      runs.find(
        (run) => run.id === selectedRunId || run.slug === selectedRunId,
      ) ?? null
    );
  }

  const activeRun = runs.find((run) => run.status === "running");
  return activeRun ?? runs[0] ?? null;
};

export const toTaskAttemptFromRun = (
  taskId: string,
  run: TaskRunRecord,
): TaskAttempt => ({
  id: run.id,
  task_id: taskId,
  status: toTaskAttemptStatus(run.status),
  created_at: run.created_at,
  updated_at: run.updated_at,
});
