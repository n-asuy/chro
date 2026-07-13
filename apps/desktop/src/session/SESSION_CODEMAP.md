# Session Code Map

Generated at: 2026-07-05T07:20:51.198Z

## Summary

- Files: 94
- Exported symbols: 299
- RPC references: 6

## File Index

| File | Exports | RPC refs |
| --- | --- | --- |
| `apps/desktop/src/session/components/agent-ask-user-question-tool.tsx` | AgentAskUserQuestionTool | - |
| `apps/desktop/src/session/components/agent-user-question.tsx` | AgentUserQuestion | - |
| `apps/desktop/src/session/components/archive-popover.tsx` | ArchivePopover | - |
| `apps/desktop/src/session/components/ask-user-questions.tsx` | AskUserAnswer, AskUserOption, AskUserQuestionItem, AskUserQuestions, ... (+1) | - |
| `apps/desktop/src/session/components/braille-spinner.tsx` | BrailleSpinner | - |
| `apps/desktop/src/session/components/branch-selector.tsx` | BranchSelector, GitBranch | - |
| `apps/desktop/src/session/components/collapsible-message.tsx` | CollapsibleMessage | - |
| `apps/desktop/src/session/components/conflict-banner.tsx` | ConflictBanner | - |
| `apps/desktop/src/session/components/conversation-find-bar.tsx` | ConversationFindBar | - |
| `apps/desktop/src/session/components/conversation-message-nav.tsx` | ConversationMessageNav | - |
| `apps/desktop/src/session/components/diff-viewer-panel.tsx` | DiffViewerPanel | - |
| `apps/desktop/src/session/components/environment-popover.tsx` | EnvironmentPopover, RebaseConfirmResult | - |
| `apps/desktop/src/session/components/execution-options-controls.tsx` | BaseBranchDropdown, BaseBranchOption, NewSessionExecutionControls, WorktreeModeDropdown | - |
| `apps/desktop/src/session/components/file-path-utils.ts` | looksLikeFilePath, stripLineColumnSuffix | - |
| `apps/desktop/src/session/components/image-upload-preview-list.tsx` | ImageUploadPreviewList | - |
| `apps/desktop/src/session/components/markdown.tsx` | Markdown | - |
| `apps/desktop/src/session/components/prompt-editor/at-popover.tsx` | AtPopover, AtPopoverHandle, AtPopoverSelection, ModelOption, ... (+2) | - |
| `apps/desktop/src/session/components/prompt-editor/prompt-editor.tsx` | PromptEditor | - |
| `apps/desktop/src/session/components/prompt-editor/skill-popover.tsx` | SkillPopover, SkillPopoverHandle | - |
| `apps/desktop/src/session/components/raw-log-text.tsx` | - | - |
| `apps/desktop/src/session/components/remark-wikilink.ts` | remarkWikilink | - |
| `apps/desktop/src/session/components/session-activity-indicator.tsx` | SessionActivityIndicator | - |
| `apps/desktop/src/session/components/session-header.tsx` | SessionHeader | - |
| `apps/desktop/src/session/components/session-input-controls.tsx` | PromptEditorWithPopover, SendButtonWithState | - |
| `apps/desktop/src/session/components/session-preview.tsx` | SessionPreviewProvider, useSessionPreviewTrigger | - |
| `apps/desktop/src/session/components/session-references-popover.tsx` | SessionReferencesPopover | /rpc/tasks/${encoded}/context-refs, /rpc/tasks/${encoded}/referenced-by |
| `apps/desktop/src/session/components/task-conversation.tsx` | TaskConversation | - |
| `apps/desktop/src/session/components/text-shimmer.tsx` | TextShimmer | - |
| `apps/desktop/src/session/components/thinking-steps.tsx` | ThinkingStep, ThinkingSteps | - |
| `apps/desktop/src/session/context/local-images-context.tsx` | LocalImageMetadata | /rpc/images/{id}/file |
| `apps/desktop/src/session/context/project-tasks-context.tsx` | ProjectTasksProvider, useOptionalProjectTasks, useProjectTasks | - |
| `apps/desktop/src/session/conversation-actions.ts` | ConversationActions, ConversationActionsContext, useConversationActions | - |
| `apps/desktop/src/session/conversation-view.tsx` | ConversationEntries, UserMessageContent | - |
| `apps/desktop/src/session/domain/conversation-history.ts` | buildTaskSessionPromptMap, ConversationFlattenCache, createConversationFlattenCache, createLoadingEntry, ... (+7) | - |
| `apps/desktop/src/session/domain/execution-mode.ts` | isWorktreeExecutionPath, resolveUseWorktreeForRun | - |
| `apps/desktop/src/session/domain/session-grouping.ts` | DateBucket, deriveDateBucket, deriveSessionState, GroupLabels, ... (+7) | - |
| `apps/desktop/src/session/domain/session-run-state.ts` | CANCELABLE_RUN_STATUSES, CancelAction, deriveSessionRunState, resolveCancelAction, ... (+2) | - |
| `apps/desktop/src/session/domain/session-task-state.ts` | applyPendingSubmissionGroupsToTasks, applyPendingSubmissionsToTasks, applyPendingSubmissionToTasks, createPendingSessionSubmission, ... (+10) | - |
| `apps/desktop/src/session/domain/task-read-state.ts` | deriveTaskStatusDot, TaskStatusDotKind | - |
| `apps/desktop/src/session/domain/task-run-selection.ts` | selectTargetTaskRun, toTaskAttemptFromRun | - |
| `apps/desktop/src/session/hooks/index.ts` | useArchivedSessions, useConversationHistory, useDiffStream, useImageUploads, ... (+19) | - |
| `apps/desktop/src/session/hooks/json-patch-stream-registry.test.ts` | - | - |
| `apps/desktop/src/session/hooks/json-patch-stream-registry.ts` | acquireStream, DISABLED_SNAPSHOT, forceCloseStream, getStreamSnapshot, ... (+4) | /rpc/events |
| `apps/desktop/src/session/hooks/use-archived-sessions.test.ts` | - | - |
| `apps/desktop/src/session/hooks/use-archived-sessions.ts` | ArchivedSession, archiveTask, ArchiveTaskApi, useArchivedSessions, ... (+1) | - |
| `apps/desktop/src/session/hooks/use-composer-file-drag.ts` | ComposerFileDrag, useComposerFileDrag | - |
| `apps/desktop/src/session/hooks/use-conversation-find.ts` | ConversationFindController, useConversationFind | - |
| `apps/desktop/src/session/hooks/use-conversation-history.ts` | useConversationHistory, UseConversationHistoryResult | - |
| `apps/desktop/src/session/hooks/use-diff-stream.ts` | useDiffStream, UseDiffStreamResult | - |
| `apps/desktop/src/session/hooks/use-image-metadata.ts` | useImageMetadata | - |
| `apps/desktop/src/session/hooks/use-image-uploads.ts` | ImageUploadItem, ImageUploadStatus, useImageUploads | /rpc/images/${item.imageId}/file |
| `apps/desktop/src/session/hooks/use-inbox-tasks-stream.ts` | useInboxTasksStream, UseInboxTasksStreamResult | - |
| `apps/desktop/src/session/hooks/use-json-patch-ws-stream.ts` | useJsonPatchWsStream, UseJsonPatchWsStreamResult | - |
| `apps/desktop/src/session/hooks/use-merge-split.tsx` | Run, SelBlock, SelectionBackgrounds, useMergeSplitBlocks | - |
| `apps/desktop/src/session/hooks/use-project-tasks-stream.ts` | useProjectTasksStream, UseProjectTasksStreamResult | - |
| `apps/desktop/src/session/hooks/use-prompt-draft-persistence.ts` | usePromptDraftPersistence | - |
| `apps/desktop/src/session/hooks/use-prompt-editor.ts` | parseFromDOM, usePromptEditor, usePromptEditorHandle, UsePromptEditorResult | - |
| `apps/desktop/src/session/hooks/use-prompt-queue-controller.ts` | QueuedPromptItem, usePromptQueueController | - |
| `apps/desktop/src/session/hooks/use-proximity-hover.ts` | ItemRect, useProximityHover | - |
| `apps/desktop/src/session/hooks/use-session-execution-options.ts` | useSessionExecutionOptions | - |
| `apps/desktop/src/session/hooks/use-session-read-state.ts` | useMarkViewedWhenActive, useSessionReadSync, useTaskStatusDot | - |
| `apps/desktop/src/session/hooks/use-session-run-controller.ts` | useSessionRunController, UseSessionRunControllerResult | - |
| `apps/desktop/src/session/hooks/use-session-sidebar-state.ts` | useSessionSidebarState | - |
| `apps/desktop/src/session/hooks/use-session-task-state.ts` | useSessionTaskState, UseSessionTaskStateResult | - |
| `apps/desktop/src/session/hooks/use-single-session-controller.ts` | PreparedPromptPayload, useSingleSessionController | /rpc/executions/claude |
| `apps/desktop/src/session/hooks/use-task-drafts-stream.ts` | DraftType, TaskDraft, useTaskDraftsStream, UseTaskDraftsStreamResult | - |
| `apps/desktop/src/session/hooks/use-task-log-stream.test.ts` | - | - |
| `apps/desktop/src/session/hooks/use-task-log-stream.ts` | applyTaskRunPatchOperations, DiffChangeKind, DiffContent, DiffEntry, ... (+4) | - |
| `apps/desktop/src/session/hooks/use-task-runs-stream.ts` | useTaskRunsStream, UseTaskRunsStreamResult | - |
| `apps/desktop/src/session/hooks/use-task-sessions-stream.ts` | useTaskSessionsStream, UseTaskSessionsStreamResult | - |
| `apps/desktop/src/session/single-agent-session.tsx` | SingleAgentSessionView | - |
| `apps/desktop/src/session/state/pending-session-submissions-store.test.ts` | - | - |
| `apps/desktop/src/session/state/pending-session-submissions-store.ts` | BeginPendingSessionSubmissionInput, ProjectPendingSubmissions, useAllPendingSessionSubmissions, usePendingSessionSubmissions, ... (+1) | - |
| `apps/desktop/src/session/state/prompt-editor-store.test.ts` | - | - |
| `apps/desktop/src/session/state/prompt-editor-store.ts` | getActivePromptEditorHandle, getPromptEditorHandle, getPromptEditorScopeState, parseFromDOM, ... (+2) | - |
| `apps/desktop/src/session/state/session-read-store.ts` | useSessionReadStore | - |
| `apps/desktop/src/session/state/task-title-overrides-store.test.ts` | - | - |
| `apps/desktop/src/session/state/task-title-overrides-store.ts` | applyTaskTitleOverridesToTasksById, useTaskTitleOverrides, useTaskTitleOverridesStore | - |
| `apps/desktop/src/session/state/user-question-store.ts` | PendingUserQuestions, QUESTIONS_SKIPPED_MESSAGE, QUESTIONS_TIMED_OUT_MESSAGE, UserQuestion, ... (+2) | - |
| `apps/desktop/src/session/types/api.ts` | ApprovalRecord, StartClaudeResponse, TaskRunRecord, TaskSessionRecord | - |
| `apps/desktop/src/session/types/context.ts` | ContentPart, contextEntriesToRefs, ContextEntry, ContextRefPayload, ... (+18) | - |
| `apps/desktop/src/session/types/execution-process.ts` | TaskAttempt | - |
| `apps/desktop/src/session/types/index.ts` | StoredTask | - |
| `apps/desktop/src/session/types/normalized.ts` | ActionType, AskUserQuestion, AskUserQuestionOption, CommandExitStatus, ... (+10) | - |
| `apps/desktop/src/session/utils/abort-controller-registry.ts` | AbortControllerRegistry, isAbortError | - |
| `apps/desktop/src/session/utils/agent-step-segments.ts` | ConversationSegment, NormalizedDisplayEntry, segmentConversationEntries, stepEntrySummary, ... (+1) | - |
| `apps/desktop/src/session/utils/ask-user-question-mapping.ts` | formatQuestionAnswers, questionId, toAskUserQuestionItems | - |
| `apps/desktop/src/session/utils/conversation-find-highlighter.ts` | clearHighlightRanges, collectMatchRanges, isHighlightApiSupported, setHighlightRanges | - |
| `apps/desktop/src/session/utils/json-patch-stream.test.ts` | - | - |
| `apps/desktop/src/session/utils/json-patch-stream.ts` | dedupeJsonPatchOperations, JsonPatchPathOperation | - |
| `apps/desktop/src/session/utils/session-dnd.ts` | parseSessionDragPayload, serializeSessionDragPayload, SESSION_DRAG_DATA_TYPE, SessionDragPayload | - |
| `apps/desktop/src/session/utils/session-select-all.ts` | activateSessionSelectScope, clearSessionSelectHighlight, clearSessionSelectState, getSelectableMessageElements, ... (+10) | - |
| `apps/desktop/src/session/utils/task-message-api.ts` | cancelTaskRun, sendTaskMessage | - |

## Notes

- This map is generated from static source analysis.
- It is intended for both human review and AI context priming.
- Regenerate with `bun run codemap:session`.
