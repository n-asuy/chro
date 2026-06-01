/**
 * NormalizedEntry types - must match crates/log-types/src/normalized.rs
 */

export type CommandExitStatus =
  | { type: "exit_code"; code: number }
  | { type: "success"; success: boolean };

export type CommandRunResult = {
  exit_status?: CommandExitStatus | null;
  output?: string | null;
};

export type FileChange =
  | { action: "write"; content: string }
  | { action: "delete" }
  | { action: "rename"; new_path: string }
  | {
      action: "edit";
      unified_diff: string;
      has_line_numbers: boolean;
    };

export type TodoItem = {
  content: string;
  status: string;
  priority?: string | null;
};

/**
 * AskUserQuestion tool input types
 */
export type AskUserQuestionOption = {
  label: string;
  description: string;
};

export type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
};

export type AskUserQuestionInput = {
  questions: AskUserQuestion[];
};

export type ToolResultValueType = "markdown" | "json";

export type ToolResult = {
  type: ToolResultValueType;
  value: unknown;
};

export type ActionType =
  | { action: "file_read"; path: string }
  | { action: "file_edit"; path: string; changes?: FileChange[] }
  | { action: "command_run"; command: string; result?: CommandRunResult | null }
  | { action: "search"; query: string }
  | { action: "web_fetch"; url: string }
  | {
      action: "tool";
      tool_name: string;
      arguments?: unknown;
      result?: ToolResult | null;
    }
  | { action: "task_create"; description: string }
  | { action: "plan_presentation"; plan: string }
  | { action: "todo_management"; todos: TodoItem[]; operation: string }
  | { action: "other"; description: string };

export type ToolStatus =
  | { status: "created" }
  | { status: "success" }
  | { status: "failed" }
  | { status: "denied"; reason?: string | null }
  | {
      status: "pending_approval";
      approval_id: string;
      requested_at: string;
      timeout_at: string;
    }
  | { status: "timed_out" };

/**
 * Error type classification - matches NormalizedEntryError in Rust
 */
export type NormalizedEntryError =
  | { type: "setup_required" }
  | { type: "other" };

/**
 * Entry type discriminated union - matches NormalizedEntryType in Rust
 */
export type NormalizedEntryType =
  | { type: "user_message" }
  | { type: "user_feedback"; denied_tool: string }
  | { type: "assistant_message" }
  | {
      type: "tool_use";
      tool_name: string;
      action_type: ActionType;
      status: ToolStatus;
    }
  | { type: "system_message" }
  | { type: "error_message"; error_type?: NormalizedEntryError }
  | { type: "thinking" }
  | { type: "loading" }
  | {
      type: "next_action";
      failed: boolean;
      execution_processes: number;
      needs_setup: boolean;
    };

/**
 * A normalized entry representing a single piece of agent conversation.
 * The `id` field is added client-side for React keys.
 */
export type NormalizedEntry = {
  id: string;
  timestamp?: string | null;
  entry_type: NormalizedEntryType;
  content: string;
  metadata?: Record<string, unknown>;
};

/**
 * Display entry type with key.
 * Keeps NORMALIZED_ENTRY, STDOUT, STDERR as separate types for proper rendering.
 */
export type DisplayEntry =
  | { type: "NORMALIZED_ENTRY"; content: NormalizedEntry; key: string }
  | { type: "STDOUT"; content: string; key: string }
  | { type: "STDERR"; content: string; key: string };
