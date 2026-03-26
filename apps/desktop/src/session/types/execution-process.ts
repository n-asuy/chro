/**
 * ExecutionProcess types - must match backend Rust types
 */

export type TaskAttempt = {
  id: string;
  task_id: string;
  status: "running" | "completed" | "failed" | "killed";
  container_ref?: string | null;
  branch?: string;
  target_branch?: string;
  executor?: string;
  worktree_deleted?: boolean;
  setup_completed_at?: string | null;
  created_at: string;
  updated_at: string;
};
