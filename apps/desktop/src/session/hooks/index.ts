export { useJsonPatchWsStream } from "./use-json-patch-ws-stream";
export type {
  LogEntryMessage,
  UseJsonPatchWsStreamOptions,
  UseJsonPatchWsStreamResult,
} from "./use-json-patch-ws-stream";

export { useTaskRunStream } from "./use-task-log-stream";
export type {
  UseTaskRunStreamResult,
  DiffChangeKind,
  DiffContent,
  DiffEntry,
  PatchDocument,
} from "./use-task-log-stream";

export { useDiffStream } from "./use-diff-stream";
export type { UseDiffStreamResult } from "./use-diff-stream";

// WebSocket streams using /streams/* endpoints
export { useProjectTasksStream } from "./use-project-tasks-stream";
export type { UseProjectTasksStreamResult } from "./use-project-tasks-stream";

export { useInboxTasksStream } from "./use-inbox-tasks-stream";
export type { UseInboxTasksStreamResult } from "./use-inbox-tasks-stream";

export { useTaskRunsStream } from "./use-task-runs-stream";
export type { UseTaskRunsStreamResult } from "./use-task-runs-stream";

export { useTaskSessionsStream } from "./use-task-sessions-stream";
export type { UseTaskSessionsStreamResult } from "./use-task-sessions-stream";

export { useTaskDraftsStream } from "./use-task-drafts-stream";
export type {
  UseTaskDraftsStreamResult,
  TaskDraft,
  DraftType,
} from "./use-task-drafts-stream";

export { useImageUploads } from "./use-image-uploads";
export type { ImageUploadItem, ImageUploadStatus } from "./use-image-uploads";

export { usePromptDraftPersistence } from "./use-prompt-draft-persistence";
export { usePromptEditor, usePromptEditorHandle } from "./use-prompt-editor";
export type { UsePromptEditorResult } from "./use-prompt-editor";

export { useConversationHistory } from "./use-conversation-history";
export type { UseConversationHistoryResult } from "./use-conversation-history";

export { useSessionTaskState } from "./use-session-task-state";
export type { UseSessionTaskStateResult } from "./use-session-task-state";

export { useArchivedSessions } from "./use-archived-sessions";
export type {
  ArchivedSession,
  UseArchivedSessionsResult,
} from "./use-archived-sessions";

export { useSingleSessionController } from "./use-single-session-controller";
export type { PreparedPromptPayload } from "./use-single-session-controller";

export { useSessionRunController } from "./use-session-run-controller";
export type { UseSessionRunControllerResult } from "./use-session-run-controller";

export { usePromptQueueController } from "./use-prompt-queue-controller";
export type { QueuedPromptItem } from "./use-prompt-queue-controller";

export { useSessionExecutionOptions } from "./use-session-execution-options";
export { useSessionSidebarState } from "./use-session-sidebar-state";
export {
  useSessionReadSync,
  useTaskStatusDot,
  useMarkViewedWhenActive,
} from "./use-session-read-state";
