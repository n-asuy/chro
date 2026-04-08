export type StartClaudeResponse = {
  execution_id: string;
  task_run_id: string;
  task_id: string;
  project_id: string;
  executor_session_id: string;
  task_slug?: string | null;
  task_run_slug?: string | null;
};

export type TaskRunRecord = {
  id: string;
  slug?: string | null;
  task_id: string;
  execution_mode: string;
  status: string;
  run_reason: string | null;
  executor_action: string | null;
  executor_action_type: string | null;
  exit_code: number | null;
  dropped: boolean;
  before_head_commit: string | null;
  after_head_commit: string | null;
  branch_name: string | null;
  target_branch: string | null;
  container_ref: string | null;
  workspace_path: string | null;
  executor_label: string | null;
  resume_session_id: string | null;
  worktree_deleted: boolean;
  executor_job_id: string | null;
  s3_prefix: string | null;
  logs_uri: string | null;
  summary_uri: string | null;
  diffs_prefix: string | null;
  logs_retrieval_failed: boolean;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskSessionRecord = {
  id: string;
  task_id: string;
  task_run_id: string | null;
  agent_profile_id: string;
  external_session_id: string | null;
  prompt: string | null;
  summary: string | null;
  handoff_from_session_id: string | null;
  worktree_commit: string | null;
  state_snapshot: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type ApprovalStatusDoc =
  | { status: "pending" }
  | { status: "approved" }
  | { status: "timed_out" }
  | { status: "denied"; reason?: string | null };

export type ApprovalRecord = {
  id: string;
  task_run_id: string;
  tool_name: string;
  tool_input: unknown;
  created_at: string;
  timeout_at: string;
  status: ApprovalStatusDoc;
};
