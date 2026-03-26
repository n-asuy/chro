# Session Code Map

Generated at: 2026-02-24T07:32:20.227Z

## Summary

- Files: 50
- Exported symbols: 157
- RPC references: 4

## File Index

| File | Exports | RPC refs |
| --- | --- | --- |
| `apps/desktop/src/session/components/agent-ask-user-question-tool.tsx` | AgentAskUserQuestionTool | - |
| `apps/desktop/src/session/components/agent-user-question.tsx` | AgentUserQuestion, AgentUserQuestionHandle | - |
| `apps/desktop/src/session/components/approval-panel.tsx` | ApprovalPanel | - |
| `apps/desktop/src/session/components/archive-popover.tsx` | ArchivePopover | - |
| `apps/desktop/src/session/components/branch-selector.tsx` | BranchSelector, GitBranch | - |
| `apps/desktop/src/session/components/conflict-banner.tsx` | ConflictBanner, ConflictBannerProps | - |
| `apps/desktop/src/session/components/diff-viewer-dialog.tsx` | DiffViewerDialog | - |
| `apps/desktop/src/session/components/diff-viewer-panel.tsx` | DiffViewerPanel | - |
| `apps/desktop/src/session/components/image-upload-preview-list.tsx` | ImageUploadPreviewList | - |
| `apps/desktop/src/session/components/markdown.tsx` | Markdown | - |
| `apps/desktop/src/session/components/prompt-editor/at-popover.tsx` | AtPopover, AtPopoverHandle | - |
| `apps/desktop/src/session/components/prompt-editor/prompt-editor.tsx` | PromptEditor | - |
| `apps/desktop/src/session/components/raw-log-text.tsx` | - | - |
| `apps/desktop/src/session/components/rebase-dialog.tsx` | RebaseDialog, RebaseDialogResult | - |
| `apps/desktop/src/session/components/remark-wikilink.ts` | remarkWikilink, WikilinkNode | - |
| `apps/desktop/src/session/components/session-header.tsx` | SessionHeader | - |
| `apps/desktop/src/session/components/session-input-controls.tsx` | AgentUserQuestionWithEditorState, PromptEditorWithPopover, PromptQueueIndicator, PromptQueueItem, ... (+1) | - |
| `apps/desktop/src/session/components/session-list.tsx` | SessionList | - |
| `apps/desktop/src/session/components/session-sidebar-content.tsx` | SessionSidebarContent | - |
| `apps/desktop/src/session/components/task-conversation.tsx` | TaskConversation, TaskConversationProps | - |
| `apps/desktop/src/session/components/text-shimmer.tsx` | TextShimmer | - |
| `apps/desktop/src/session/context/local-images-context.tsx` | LocalImageMetadata, LocalImagesContext, TaskIdContext, useLocalImages, ... (+1) | /rpc/images/{id}/file |
| `apps/desktop/src/session/conversation-view.tsx` | ConversationEntries, ConversationEntriesProps | - |
| `apps/desktop/src/session/domain/execution-mode.ts` | isWorktreeExecutionPath, normalizePathForExecutionModeCompare, resolveUseWorktreeForRun | - |
| `apps/desktop/src/session/domain/task-run-selection.ts` | selectTargetTaskRun, toTaskAttemptFromRun | - |
| `apps/desktop/src/session/hooks/index.ts` | useArchivedSessions, useConversationHistory, useDiffStream, useImageUploads, ... (+9) | - |
| `apps/desktop/src/session/hooks/use-archived-sessions.ts` | ArchivedSession, useArchivedSessions, UseArchivedSessionsResult | - |
| `apps/desktop/src/session/hooks/use-conversation-history.ts` | useConversationHistory, UseConversationHistoryResult | - |
| `apps/desktop/src/session/hooks/use-diff-stream.ts` | useDiffStream, UseDiffStreamResult | - |
| `apps/desktop/src/session/hooks/use-image-metadata.ts` | ImageMetadata, useImageMetadata | - |
| `apps/desktop/src/session/hooks/use-image-uploads.ts` | ImageUploadItem, ImageUploadStatus, useImageUploads | /rpc/images/${item.imageId}/file |
| `apps/desktop/src/session/hooks/use-json-patch-ws-stream.ts` | LogEntryMessage, useJsonPatchWsStream, UseJsonPatchWsStreamOptions, UseJsonPatchWsStreamResult | - |
| `apps/desktop/src/session/hooks/use-project-tasks-stream.ts` | useProjectTasksStream, UseProjectTasksStreamResult | - |
| `apps/desktop/src/session/hooks/use-prompt-editor.ts` | parseFromDOM, usePromptEditor, usePromptEditorHandle, UsePromptEditorResult | - |
| `apps/desktop/src/session/hooks/use-prompt-queue-controller.ts` | QueuedPromptItem, usePromptQueueController | - |
| `apps/desktop/src/session/hooks/use-single-session-controller.ts` | PreparedPromptPayload, useSingleSessionController | /rpc/executions/claude, /rpc/tasks/${taskId}/runs |
| `apps/desktop/src/session/hooks/use-task-drafts-stream.ts` | DraftType, TaskDraft, useTaskDraftsStream, UseTaskDraftsStreamResult | - |
| `apps/desktop/src/session/hooks/use-task-log-stream.ts` | DiffChangeKind, DiffContent, DiffEntry, PatchDocument, ... (+2) | - |
| `apps/desktop/src/session/hooks/use-task-runs-stream.ts` | useTaskRunsStream, UseTaskRunsStreamResult | - |
| `apps/desktop/src/session/index.ts` | - | - |
| `apps/desktop/src/session/session-shell.tsx` | SessionShell | - |
| `apps/desktop/src/session/single-agent-session.tsx` | SingleAgentSessionView | - |
| `apps/desktop/src/session/state/prompt-editor-store.ts` | getPromptEditorHandle, parseFromDOM, PromptEditorHandle, usePromptEditorStore | - |
| `apps/desktop/src/session/state/user-question-store.ts` | PendingUserQuestions, QUESTIONS_SKIPPED_MESSAGE, QUESTIONS_TIMED_OUT_MESSAGE, UserQuestion, ... (+2) | - |
| `apps/desktop/src/session/types/api.ts` | ApprovalRecord, ApprovalStatusDoc, StartClaudeResponse, TaskRunRecord | - |
| `apps/desktop/src/session/types/context.ts` | ContentPart, ContextEntry, DEFAULT_PROMPT, extractSessionId, ... (+8) | - |
| `apps/desktop/src/session/types/execution-process.ts` | CodingAgentFollowUpRequest, CodingAgentInitialRequest, ExecutionProcess, ExecutionProcessRunReason, ... (+8) | - |
| `apps/desktop/src/session/types/index.ts` | StoredTask, UiEventMessage | - |
| `apps/desktop/src/session/types/normalized.ts` | ActionType, AskUserQuestion, AskUserQuestionInput, AskUserQuestionOption, ... (+14) | - |
| `apps/desktop/src/session/utils/stream-json-patch-entries.ts` | StreamController, streamJsonPatchEntries, StreamOptions | - |

## Notes

- This map is generated from static source analysis.
- It is intended for both human review and AI context priming.
- Regenerate with `bun run codemap:session`.
