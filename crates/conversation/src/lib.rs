//! Pure conversation-derivation logic ported from the desktop frontend.
//!
//! Two transformations live here, both side-effect free:
//!   - [`flatten_conversation_entries`] folds per-run conversation state into a
//!     single chronological list, injecting synthetic user prompts, filtering
//!     duplicate log user messages, and appending loading sentinels.
//!   - [`segment_conversation_entries`] groups consecutive agent "working"
//!     entries (thinking, tool calls, loading) into collapsible thinking-steps
//!     runs and derives each run's header label.
//!
//! Streaming, I/O, memoization, and approvals extraction are deliberately out
//! of scope. The wire types in [`types`] mirror the TypeScript `DisplayEntry` /
//! `NormalizedEntry` shapes so the same JSON flows through either side.

mod flatten;
mod segment;
mod types;

pub use flatten::{
    build_task_session_prompt_map, create_loading_entry, create_synthetic_user_message_entry,
    filter_conversation_log_entries, flatten_conversation_entries, FlattenOptions,
};
pub use segment::{segment_conversation_entries, step_entry_summary};
pub use types::{
    ActionType, CommandExitStatus, CommandRunResult, ConversationSegment, DisplayEntry, FileChange,
    NormalizedEntry, NormalizedEntryError, NormalizedEntryType, TaskRunConversationState,
    TaskRunPromptOverride, TaskSessionRecord, ThinkingStepsSegment, TodoItem, ToolResult,
    ToolStatus,
};
