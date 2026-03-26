import { normalizePathForCompare } from "../../lib/workspace-history";
import type { TaskRunRecord } from "../types";

const normalizePathForExecutionModeCompare = (value: string): string => {
  const normalized = normalizePathForCompare(value);
  if (normalized === "/private/var") {
    return "/var";
  }
  if (normalized.startsWith("/private/var/")) {
    return `/var/${normalized.slice("/private/var/".length)}`;
  }
  return normalized;
};

export const isWorktreeExecutionPath = (
  executionPath: string,
  workspacePath: string,
): boolean =>
  normalizePathForExecutionModeCompare(executionPath) !==
  normalizePathForExecutionModeCompare(workspacePath);

export const resolveUseWorktreeForRun = (
  run: TaskRunRecord,
  workspacePath: string | null,
): boolean => {
  if (run.worktree_deleted) {
    return true;
  }

  const executionPath = run.container_ref ?? run.workspace_path;
  if (!workspacePath || !executionPath) {
    return true;
  }

  return isWorktreeExecutionPath(executionPath, workspacePath);
};
