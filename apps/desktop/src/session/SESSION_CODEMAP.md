# Session Code Map

Generated at: 2026-04-04T09:30:10.610Z

## Summary

- Files: 59
- Exported symbols: 149
- RPC references: 4

## File Index

| File | Exports | RPC refs |
| --- | --- | --- |
| `apps/desktop/src/session/components/agent-ask-user-question-tool.tsx` | AgentAskUserQuestionTool | - |
| `apps/desktop/src/session/components/agent-user-question.tsx` | AgentUserQuestion | - |
| `apps/desktop/src/session/components/ask-user-questions.tsx` | AskUserQuestions, AskUserQuestionItem, AskUserOption, AskUserAnswer | - |
| `apps/desktop/src/session/utils/ask-user-question-mapping.ts` | questionId, toAskUserQuestionItems, formatQuestionAnswers | - |
| `apps/desktop/src/session/hooks/use-proximity-hover.ts` | useProximityHover, ItemRect | - |
| `apps/desktop/src/session/hooks/use-merge-split.tsx` | useMergeSplitBlocks, SelectionBackgrounds, SelBlock, Run | - |
| `apps/desktop/src/session/components/approval-panel.tsx` | ApprovalPanel | - |
| `apps/desktop/src/session/components/archive-popover.tsx` | ArchivePopover | - |
| `apps/desktop/src/session/components/braille-spinner.tsx` | BrailleSpinner | - |
| `apps/desktop/src/session/components/branch-selector.tsx` | BranchSelector, GitBranch | - |
| `apps/desktop/src/session/components/conflict-banner.tsx` | ConflictBanner | - |
| `apps/desktop/src/session/components/diff-viewer-panel.tsx` | DiffViewerPanel | - |
| `apps/desktop/src/session/components/image-upload-preview-list.tsx` | ImageUploadPreviewList | - |
| `apps/desktop/src/session/components/markdown.tsx` | Markdown | - |
| `apps/desktop/src/session/components/prompt-editor/at-popover.tsx` | AtPopover, AtPopoverHandle | - |
| `apps/desktop/src/session/components/prompt-editor/prompt-editor.tsx` | PromptEditor | - |
| `apps/desktop/src/session/components/raw-log-text.tsx` | - | - |
| `apps/desktop/src/session/components/rebase-dialog.tsx` | RebaseDialog, RebaseDialogResult | - |
| `apps/desktop/src/session/components/remark-wikilink.ts` | remarkWikilink | - |
| `apps/desktop/src/session/components/session-empty-state.tsx` | SessionEmptyState | - |
| `apps/desktop/src/session/components/session-header.tsx` | SessionHeader | - |
| `apps/desktop/src/session/components/session-input-controls.tsx` | PromptEditorWithPopover, SendButtonWithState | - |
| `apps/desktop/src/session/components/session-list.tsx` | SessionList | - |
| `apps/desktop/src/session/components/task-conversation.tsx` | TaskConversation | - |
| `apps/desktop/src/session/components/text-shimmer.tsx` | TextShimmer | - |
| `apps/desktop/src/session/context/local-images-context.tsx` | LocalImageMetadata | /rpc/images/{id}/file |
| `apps/desktop/src/session/conversation-view.tsx` | ConversationEntries | - |
| `apps/desktop/src/session/domain/conversation-history.ts` | buildTaskSessionPromptMap, createSyntheticUserMessageEntry, filterConversationLogEntries, flattenConversationEntries, ... (+1) | - |
| `apps/desktop/src/session/domain/execution-mode.ts` | isWorktreeExecutionPath, resolveUseWorktreeForRun | - |
| `apps/desktop/src/session/domain/task-run-selection.ts` | selectTargetTaskRun, toTaskAttemptFromRun | - |
| `apps/desktop/src/session/hooks/index.ts` | useArchivedSessions, useConversationHistory, useDiffStream, useImageUploads, ... (+12) | - |
| `apps/desktop/src/session/hooks/use-archived-sessions.ts` | ArchivedSession, useArchivedSessions, UseArchivedSessionsResult | - |
| `apps/desktop/src/session/hooks/use-conversation-history.ts` | useConversationHistory, UseConversationHistoryResult | - |
| `apps/desktop/src/session/hooks/use-diff-stream.ts` | useDiffStream, UseDiffStreamResult | - |
| `apps/desktop/src/session/hooks/use-image-metadata.ts` | useImageMetadata | - |
| `apps/desktop/src/session/hooks/use-image-uploads.ts` | ImageUploadItem, ImageUploadStatus, useImageUploads | /rpc/images/${item.imageId}/file |
| `apps/desktop/src/session/hooks/use-json-patch-ws-stream.ts` | LogEntryMessage, useJsonPatchWsStream, UseJsonPatchWsStreamOptions, UseJsonPatchWsStreamResult | - |
| `apps/desktop/src/session/hooks/use-project-tasks-stream.ts` | useProjectTasksStream, UseProjectTasksStreamResult | - |
| `apps/desktop/src/session/hooks/use-prompt-editor.ts` | parseFromDOM, usePromptEditor, usePromptEditorHandle, UsePromptEditorResult | - |
| `apps/desktop/src/session/hooks/use-prompt-queue-controller.ts` | QueuedPromptItem, usePromptQueueController | - |
| `apps/desktop/src/session/hooks/use-session-execution-options.ts` | useSessionExecutionOptions | - |
| `apps/desktop/src/session/hooks/use-session-sidebar-state.ts` | useSessionSidebarState | - |
| `apps/desktop/src/session/hooks/use-single-session-controller.ts` | PreparedPromptPayload, useSingleSessionController | /rpc/executions/claude, /rpc/tasks/${taskId}/runs |
| `apps/desktop/src/session/hooks/use-task-drafts-stream.ts` | DraftType, TaskDraft, useTaskDraftsStream, UseTaskDraftsStreamResult | - |
| `apps/desktop/src/session/hooks/use-task-log-stream.test.ts` | - | - |
| `apps/desktop/src/session/hooks/use-task-log-stream.ts` | applyTaskRunPatchOperations, DiffChangeKind, DiffContent, DiffEntry, ... (+4) | - |
| `apps/desktop/src/session/hooks/use-task-runs-stream.ts` | useTaskRunsStream, UseTaskRunsStreamResult | - |
| `apps/desktop/src/session/hooks/use-task-sessions-stream.ts` | useTaskSessionsStream, UseTaskSessionsStreamResult | - |
| `apps/desktop/src/session/index.ts` | - | - |
| `apps/desktop/src/session/session-shell.tsx` | SessionShell | - |
| `apps/desktop/src/session/single-agent-session.tsx` | SingleAgentSessionView | - |
| `apps/desktop/src/session/state/prompt-editor-store.ts` | getPromptEditorHandle, parseFromDOM, PromptEditorHandle, usePromptEditorStore | - |
| `apps/desktop/src/session/state/user-question-store.ts` | PendingUserQuestions, QUESTIONS_SKIPPED_MESSAGE, QUESTIONS_TIMED_OUT_MESSAGE, UserQuestion, ... (+2) | - |
| `apps/desktop/src/session/types/api.ts` | ApprovalRecord, StartClaudeResponse, TaskRunRecord, TaskSessionRecord | - |
| `apps/desktop/src/session/types/context.ts` | ContentPart, ContextEntry, DEFAULT_PROMPT, extractSessionId, ... (+7) | - |
| `apps/desktop/src/session/types/execution-process.ts` | TaskAttempt | - |
| `apps/desktop/src/session/types/index.ts` | StoredTask, UiEventMessage | - |
| `apps/desktop/src/session/types/normalized.ts` | ActionType, AskUserQuestion, AskUserQuestionInput, AskUserQuestionOption, ... (+11) | - |
| `apps/desktop/src/session/utils/json-patch-stream.test.ts` | - | - |
| `apps/desktop/src/session/utils/json-patch-stream.ts` | dedupeJsonPatchOperations, JsonPatchPathOperation | - |
| `apps/desktop/src/session/utils/session-dnd.ts` | parseSessionDragPayload, serializeSessionDragPayload, SESSION_DRAG_DATA_TYPE, SessionDragPayload | - |
| `apps/desktop/src/session/utils/task-message-api.ts` | sendTaskMessage | - |

## Notes

- This map is generated from static source analysis.
- It is intended for both human review and AI context priming.
- Regenerate with `bun run codemap:session`.
