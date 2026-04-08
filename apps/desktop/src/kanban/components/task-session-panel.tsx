import { useFilesStore } from "@/files/state/files-store";
import { useBranchStatus } from "@/hooks/use-branch-status";
import {
  extractFilesFromDataTransfer,
  useGlobalFileDrop,
} from "@/hooks/use-global-file-drop";
import { useRebase } from "@/hooks/use-rebase";
import { useLanguage } from "@/i18n";
import { useWorkspaceBoardContext } from "@/kanban/providers";
import type { BoardIssue } from "@/kanban/types";
import { desktopFetch } from "@/lib/backend-client";
import { cn } from "@/lib/cn";
import {
  type BaseCodingAgent,
  type ExecutorConfigs,
  type ExecutorProfileId,
  fetchExecutorProfile,
} from "@/lib/executor-client";
import { listGitBranches } from "@/lib/git-client";
import { ApprovalPanel } from "@/session/components/approval-panel";
import type { GitBranch as GitBranchType } from "@/session/components/branch-selector";
import { DiffViewerPanel } from "@/session/components/diff-viewer-panel";
import { ImageUploadPreviewList } from "@/session/components/image-upload-preview-list";
import {
  RebaseDialog,
  type RebaseDialogResult,
} from "@/session/components/rebase-dialog";
import { TaskConversation } from "@/session/components/task-conversation";
import {
  useConversationHistory,
  useDiffStream,
  useTaskRunStream,
} from "@/session/hooks";
import { useImageUploads } from "@/session/hooks/use-image-uploads";
import { sendTaskMessage } from "@/session/utils/task-message-api";
import { Button } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { Textarea } from "@chro/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Command,
  Image as ImageIcon,
  Laptop,
  Loader2,
  Square,
} from "lucide-react";
import {
  type KeyboardEvent,
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PeekMode } from "./peek-header";

export type DiffActionState = {
  canOpenDiffViewer: boolean;
  canMergeDiffs: boolean;
  canRebase: boolean;
  isMergingDiffs: boolean;
  isMerged: boolean;
  isRebasing: boolean;
  /** Commits behind the default branch used for diff action state. */
  commitsBehind: number;
  onOpenDiffViewer: () => void;
  onMergeDiffs: () => Promise<void> | void;
  onRebase: () => void;
};

const DEFAULT_EXECUTORS: BaseCodingAgent[] = ["CLAUDE_CODE", "CODEX"];

const parseExecutorProfileId = (
  value: string | null | undefined,
): ExecutorProfileId | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ExecutorProfileId;
    if (!parsed || !parsed.executor) return null;
    return {
      executor: parsed.executor,
      variant: parsed.variant ?? null,
    };
  } catch (error) {
    console.warn(
      "[task-session-panel] Failed to parse executor profile",
      error,
    );
    return null;
  }
};

interface TaskSessionPanelProps {
  issue: BoardIssue;
  peekMode?: PeekMode;
  onDiffActionsChange?: (actions: DiffActionState | null) => void;
}

export const TaskSessionPanel = ({
  issue,
  peekMode = "side-peek",
  onDiffActionsChange,
}: TaskSessionPanelProps) => {
  const isFullScreen = peekMode === "full-screen";
  const { t } = useLanguage();
  const { workspacePath, projectId } = useWorkspaceBoardContext();
  const navigateToWikilink = useFilesStore((state) => state.navigateToWikilink);
  const [input, setInput] = useState("");
  const [isStopping, setIsStopping] = useState(false);
  const [diffViewerOpen, setDiffViewerOpen] = useState(false);
  const handleOpenDiffViewer = useCallback(() => setDiffViewerOpen(true), []);
  const [isMergingDiffs, setIsMergingDiffs] = useState(false);
  const [isMerged, setIsMerged] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [rebaseDialogOpen, setRebaseDialogOpen] = useState(false);
  const [useWorktree, setUseWorktree] = useState(true);
  const [isGitRepository, setIsGitRepository] = useState(true);
  const [executorProfileId, setExecutorProfileId] =
    useState<ExecutorProfileId | null>(null);
  const [executorConfigs, setExecutorConfigs] =
    useState<ExecutorConfigs | null>(null);
  const [executorProfileLoading, setExecutorProfileLoading] = useState(true);
  const [sessionExecutorProfile, setSessionExecutorProfile] =
    useState<ExecutorProfileId | null>(null);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const forceNewAttemptRef = useRef(false);
  const isComposingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Single source of truth: WebSocket-based run discovery
  const {
    entries: conversationEntries,
    isLoading: isConversationLoading,
    error: conversationError,
    activeRunId,
    latestRunId,
  } = useConversationHistory({
    taskId: issue.id,
    enabled: Boolean(issue.id),
  });

  // Derived from WebSocket — no REST fallback
  const taskRunId = activeRunId ?? latestRunId;
  const isSending = activeRunId !== null;

  useEffect(() => {
    setUseWorktree(true);
    setIsGitRepository(true);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setIsGitRepository(true);
      return;
    }

    let cancelled = false;

    listGitBranches(projectId)
      .then(({ isRepository }) => {
        if (cancelled) return;
        setIsGitRepository(isRepository);
        if (!isRepository) {
          setUseWorktree(false);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn(
          "[task-session-panel] Failed to determine git repository state",
          error,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    const loadExecutorProfile = async () => {
      setExecutorProfileLoading(true);
      try {
        const response = await fetchExecutorProfile();
        if (cancelled) return;
        setExecutorProfileId(response.profile);
        setExecutorConfigs(response.profiles);
        setSessionExecutorProfile((prev) => prev ?? response.profile);
      } catch (error) {
        if (cancelled) return;
        setExecutorConfigs(null);
        console.warn(
          "[task-session-panel] Failed to load executor profile",
          error,
        );
      } finally {
        if (!cancelled) {
          setExecutorProfileLoading(false);
        }
      }
    };

    void loadExecutorProfile();
    return () => {
      cancelled = true;
    };
  }, [t]);

  // Log stream hook — provides approvals and document for diffs
  const logStream = useTaskRunStream({
    taskRunId,
    callbacks: {
      onError: (error) => {
        console.warn("[task-session-panel] LogStream error:", error);
      },
    },
  });

  const diffStream = useDiffStream({
    taskRunId,
    enabled: Boolean(taskRunId),
  });

  const availableExecutors = useMemo(() => {
    if (!executorConfigs) {
      return DEFAULT_EXECUTORS;
    }
    const executors = Object.keys(
      executorConfigs.executors,
    ) as BaseCodingAgent[];
    return executors.length ? executors : DEFAULT_EXECUTORS;
  }, [executorConfigs]);
  const executorLabels = useMemo(
    () => ({
      CLAUDE_CODE: t("mcpExecutorOptionClaude"),
      CODEX: t("mcpExecutorOptionCodex"),
    }),
    [t],
  );
  const sessionExecutorSelection = sessionExecutorProfile ?? executorProfileId;
  const executorDisplayLabel = useMemo(() => {
    if (!sessionExecutorSelection) {
      return t("claudeModelUnknown");
    }
    return (
      executorLabels[sessionExecutorSelection.executor] ??
      sessionExecutorSelection.executor
    );
  }, [executorLabels, sessionExecutorSelection, t]);

  const isExecutorLocked = Boolean(taskRunId) || isSending;
  const executorSelectorLabel = executorProfileLoading
    ? t("loadingMessage")
    : executorDisplayLabel;
  const diffItems = useMemo(
    () =>
      Object.entries(diffStream.diffs)
        .map(([path, entry]) => ({ path, entry }))
        .sort((a, b) =>
          a.path.localeCompare(b.path, undefined, { numeric: true }),
        ),
    [diffStream.diffs],
  );
  const diffViewerItems = useMemo(
    () => diffItems.map((item) => ({ path: item.path, diff: item.entry })),
    [diffItems],
  );
  const hasDiffs = diffItems.length > 0;

  const approvalItems = useMemo(
    () =>
      Object.values(logStream.document.approvals).sort((a, b) => {
        const left = new Date(b.created_at).getTime();
        const right = new Date(a.created_at).getTime();
        return Number.isNaN(left) || Number.isNaN(right) ? 0 : left - right;
      }),
    [logStream.document.approvals],
  );

  const hasApprovals = approvalItems.length > 0;

  useEffect(() => {
    if (!hasDiffs) {
      setDiffViewerOpen(false);
    }
  }, [hasDiffs]);

  useEffect(() => {
    return () => {
      onDiffActionsChange?.(null);
    };
  }, [onDiffActionsChange]);

  const addErrorMessage = useCallback((message: string) => {
    console.error("[TaskSessionPanel] Error:", message);
  }, []);

  const handleExecutorSelect = useCallback(
    (executor: BaseCodingAgent) => {
      if (isExecutorLocked) return;
      const variant =
        executorProfileId?.executor === executor
          ? executorProfileId.variant ?? null
          : null;
      setSessionExecutorProfile({ executor, variant });
    },
    [executorProfileId, isExecutorLocked],
  );

  const formatUploadError = useCallback(
    (file: File, error: unknown) => {
      const detail =
        error instanceof Error ? error.message : t("internalError");
      return t("imageUploadFailed", { name: file.name, error: detail });
    },
    [t],
  );

  const getUploadTarget = useCallback(() => {
    if (taskRunId && !forceNewAttemptRef.current) {
      return { type: "taskRun" as const, taskRunId };
    }
    return { type: "global" as const };
  }, [taskRunId]);

  const {
    uploadItems,
    fileInputRef,
    handleFiles,
    handleSelectFiles,
    handleRetryUpload,
    handleRemoveUpload,
    clearUploadItems,
    getImageIds,
    getImagesMarkdown,
  } = useImageUploads({
    getUploadTarget,
    setInput,
    addErrorMessage,
    formatUploadError,
  });

  const isUploading = uploadItems.some((item) => item.status === "uploading");
  const canSend = Boolean(workspacePath) && !isSending && !isUploading;
  const isSendButtonDisabled = isSending ? false : !canSend || !input.trim();

  const archiveCurrentEntries = useCallback(() => {
    logStream.resetEntries();
  }, [logStream.resetEntries]);

  const handleDropFiles = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const files = extractFilesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      handleFiles(files);
    },
    [handleFiles],
  );

  const handlePasteFiles = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = extractFilesFromDataTransfer(event.clipboardData);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      handleFiles(files);
    },
    [handleFiles],
  );

  useGlobalFileDrop(handleFiles);

  // No-op: board refresh is automatic via stream updates

  const handleCancel = useCallback(async () => {
    if (!isSending || isStopping) return;
    if (!taskRunId) return;
    try {
      setIsStopping(true);
      await desktopFetch(
        `/rpc/task-runs/${encodeURIComponent(taskRunId)}/cancel`,
        { method: "POST" },
      );
    } catch {
      // Ignore errors - execution may have already finished
    } finally {
      setIsStopping(false);
    }
  }, [isSending, isStopping, taskRunId]);

  const { status: branchStatus, refetch: refetchBranchStatus } =
    useBranchStatus({
      taskRunId,
      enabled: Boolean(taskRunId && hasDiffs),
      pollInterval: 10000,
    });

  const handleMergeDiffs = useCallback(async () => {
    if (!taskRunId || isMergingDiffs || isMerged) {
      return;
    }
    setIsMergingDiffs(true);
    try {
      await desktopFetch<{ merge_commit: string; target_branch: string }>(
        `/rpc/task-runs/${encodeURIComponent(taskRunId)}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      logStream.resetDocument();
      setDiffViewerOpen(false);
      setIsMerged(true);
      // Set success state temporarily
      setMergeSuccess(true);
      setTimeout(() => setMergeSuccess(false), 2000);
      // Refetch branch status to update commits_ahead immediately
      void refetchBranchStatus();
    } catch (err) {
      console.error("[task-session-panel] failed to merge diffs", err);
      addErrorMessage(
        err instanceof Error ? err.message : t("diffMergeErrorMessage"),
      );
    } finally {
      setIsMergingDiffs(false);
    }
  }, [
    addErrorMessage,
    isMerged,
    isMergingDiffs,
    logStream.resetDocument,
    refetchBranchStatus,
    t,
    taskRunId,
  ]);

  const handleRebaseSuccess = useCallback(() => {
    setRebaseDialogOpen(false);
    // Refetch branch status to update commits_behind immediately
    void refetchBranchStatus();
  }, [refetchBranchStatus]);

  const handleRebaseError = useCallback(
    (error: Error) => {
      addErrorMessage(error.message || t("rebaseErrorMessage"));
    },
    [addErrorMessage, t],
  );

  const { rebase, isRebasing } = useRebase({
    taskRunId,
    onSuccess: handleRebaseSuccess,
    onError: handleRebaseError,
  });

  const commitsAhead = branchStatus?.commits_ahead ?? 0;

  // Disable only while the merge mutation is active.
  const commitsBehind = branchStatus?.commits_behind ?? 0;
  const canMergeDiffs = Boolean(
    taskRunId &&
      hasDiffs &&
      !isMergingDiffs &&
      (commitsAhead > 0 || mergeSuccess),
  );

  useEffect(() => {
    if (!rebaseDialogOpen || !taskRunId) {
      return;
    }

    const fetchBranches = async () => {
      setIsLoadingBranches(true);
      try {
        const response = await desktopFetch<{ branches: GitBranchType[] }>(
          `/rpc/task-runs/${encodeURIComponent(taskRunId)}/branches`,
        );
        setBranches(response.branches ?? []);
      } catch (error) {
        console.error("Failed to fetch branches", error);
        setBranches([]);
      } finally {
        setIsLoadingBranches(false);
      }
    };

    void fetchBranches();
  }, [rebaseDialogOpen, taskRunId]);

  const handleRebaseConfirm = useCallback(
    (result: RebaseDialogResult) => {
      if (result.action === "canceled") {
        setRebaseDialogOpen(false);
        return;
      }
      if (result.targetBranch && result.upstreamBranch) {
        void rebase(result.targetBranch, result.upstreamBranch);
      }
    },
    [rebase],
  );

  // Disable only while the rebase mutation is active and when work is present.
  const canRebase = Boolean(
    taskRunId && hasDiffs && !isRebasing && commitsBehind > 0,
  );
  const handleOpenRebaseDialog = useCallback(() => {
    setRebaseDialogOpen(true);
  }, [setRebaseDialogOpen]);

  useEffect(() => {
    if (!onDiffActionsChange) {
      return;
    }
    if (!hasDiffs && !isMerged) {
      onDiffActionsChange(null);
      return;
    }
    onDiffActionsChange({
      canOpenDiffViewer: hasDiffs,
      canMergeDiffs,
      canRebase,
      isMergingDiffs,
      isMerged,
      isRebasing,
      commitsBehind,
      onOpenDiffViewer: handleOpenDiffViewer,
      onMergeDiffs: handleMergeDiffs,
      onRebase: handleOpenRebaseDialog,
    });
  }, [
    canRebase,
    canMergeDiffs,
    commitsBehind,
    handleOpenRebaseDialog,
    handleMergeDiffs,
    handleOpenDiffViewer,
    hasDiffs,
    isMerged,
    isMergingDiffs,
    isRebasing,
    onDiffActionsChange,
  ]);

  // Reset forceNewAttempt when runs arrive
  useEffect(() => {
    if (taskRunId) {
      forceNewAttemptRef.current = false;
    }
  }, [taskRunId]);

  const handleSend = useCallback(async () => {
    if (!input.trim()) return;
    if (!workspacePath) {
      addErrorMessage(t("workspaceNotSetError"));
      return;
    }

    const imagesMarkdown = getImagesMarkdown();
    const prompt = imagesMarkdown
      ? `${imagesMarkdown}\n${input.trim()}`
      : input.trim();
    const imageIds = getImageIds();
    archiveCurrentEntries();

    try {
      const taskMessageMode = forceNewAttemptRef.current ? "new" : "auto";
      const executorProfilePayload =
        sessionExecutorSelection ?? executorProfileId;
      await sendTaskMessage(issue.id, {
        prompt,
        mode: taskMessageMode,
        executorProfileId: executorProfilePayload,
        imageIds,
        useWorktree,
      });
      // WebSocket will pick up the new run automatically
      forceNewAttemptRef.current = false;
      setInput("");
      clearUploadItems();
    } catch (err) {
      console.error("[task-session-panel] failed to send prompt", err);
      const fallback =
        err instanceof Error
          ? err.message
          : t("commandFailedError", { message: t("claudeCliHint") });
      addErrorMessage(fallback);
    }
  }, [
    addErrorMessage,
    archiveCurrentEntries,
    clearUploadItems,
    getImageIds,
    getImagesMarkdown,
    input,
    issue.id,
    t,
    useWorktree,
    workspacePath,
    executorProfileId,
    sessionExecutorSelection,
  ]);

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter") {
        return;
      }

      if (event.nativeEvent.isComposing || isComposingRef.current) {
        return;
      }

      if (event.shiftKey || event.altKey) {
        return;
      }

      const onMac = navigator.platform.toLowerCase().includes("mac");
      if (onMac ? !event.metaKey : !event.ctrlKey) {
        return;
      }

      if (!canSend || !input.trim()) {
        return;
      }

      event.preventDefault();
      void handleSend();
    },
    [canSend, handleSend, input],
  );

  // Reset merge state when switching issues
  useEffect(() => {
    setIsMerged(false);
  }, [issue.id]);

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden font-workspace text-[12px] leading-[1.35]">
        {diffViewerOpen ? (
          <DiffViewerPanel
            onClose={() => setDiffViewerOpen(false)}
            diffs={diffViewerItems}
            taskRunId={taskRunId}
          />
        ) : (
          <>
            {hasApprovals && (
              <ApprovalPanel
                approvals={logStream.document.approvals}
                t={t}
                onApprovalUpdate={() => {
                  // Stream updates automatically refresh the board
                }}
              />
            )}

            <TaskConversation
              entries={conversationEntries}
              isLoading={isConversationLoading}
              error={conversationError}
              messagesEndRef={messagesEndRef}
              onWikilinkClick={navigateToWikilink}
            />

            <div
              className={cn(
                "bg-background/80 backdrop-blur",
                isFullScreen ? "px-4 pb-4 pt-3" : "px-6 py-4",
              )}
            >
              <div
                className={cn(
                  "w-full",
                  isFullScreen ? "mx-auto max-w-2xl" : "",
                )}
              >
                <div
                  className="flex flex-col gap-3 rounded-2xl border border-custom-border-200 bg-background p-4 shadow-sm focus-within:shadow-md"
                  onDrop={handleDropFiles}
                  onDragOver={(event) => event.preventDefault()}
                  role="presentation"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => handleFiles(event.target.files)}
                  />

                  <ImageUploadPreviewList
                    items={uploadItems}
                    t={t}
                    onRetryUpload={handleRetryUpload}
                    onRemoveUpload={handleRemoveUpload}
                    className="-mt-1"
                  />

                  <Textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="Describe the next step for this task"
                    disabled={isSending || !workspacePath}
                    className="max-h-48 min-h-[96px] w-full resize-none border-none bg-transparent p-0 text-sm leading-relaxed shadow-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:ring-transparent disabled:cursor-not-allowed"
                    onKeyDown={handleInputKeyDown}
                    onDrop={handleDropFiles}
                    onPaste={handlePasteFiles}
                    onDragOver={(event) => event.preventDefault()}
                    onCompositionStart={() => {
                      isComposingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      isComposingRef.current = false;
                    }}
                  />

                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <TooltipProvider delayDuration={120}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t("attachmentButtonAria")}
                              disabled={isSending}
                              onClick={handleSelectFiles}
                              className={cn(
                                "flex h-9 w-9 items-center justify-center rounded-[4px] text-muted-foreground transition hover:bg-muted/40 hover:text-primary",
                                uploadItems.length > 0 &&
                                  "bg-primary/10 text-primary",
                                "disabled:cursor-not-allowed disabled:opacity-40",
                              )}
                            >
                              <ImageIcon className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[11px]">
                            {t("attachmentButtonAria")}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>

                      <div className="mx-1 h-4 w-px bg-border" />

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={
                              isExecutorLocked ||
                              executorProfileLoading ||
                              availableExecutors.length === 0
                            }
                            className={cn(
                              "flex h-9 items-center justify-center gap-1.5 rounded-[4px] px-2 text-xs font-medium text-muted-foreground transition hover:bg-muted/40 hover:text-primary",
                              isExecutorLocked && "bg-muted/40",
                              "disabled:cursor-not-allowed disabled:opacity-40",
                            )}
                          >
                            <span className="text-xs">
                              {executorSelectorLabel}
                            </span>
                            <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          {availableExecutors.map((executor) => {
                            const isActive =
                              sessionExecutorSelection?.executor === executor;
                            return (
                              <DropdownMenuItem
                                key={executor}
                                onClick={() => handleExecutorSelect(executor)}
                                className="flex items-center justify-between gap-3 text-[11px]"
                              >
                                <span>
                                  {executorLabels[executor] ??
                                    executor.replace(/_/g, " ")}
                                </span>
                                {isActive ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : null}
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    <div className="flex items-center gap-2">
                      <TooltipProvider delayDuration={120}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={isSending ? handleCancel : handleSend}
                              disabled={isSendButtonDisabled || isStopping}
                              className={cn(
                                "flex h-8 w-8 items-center justify-center rounded-full transition",
                                isSending
                                  ? "bg-primary/10 text-primary"
                                  : isSendButtonDisabled
                                    ? "bg-muted text-muted-foreground"
                                    : "bg-primary text-white hover:!bg-primary/90 hover:!text-white",
                                "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:bg-muted disabled:hover:text-muted-foreground disabled:opacity-100",
                              )}
                              aria-label={
                                isSending
                                  ? t("stopButtonLabel")
                                  : t("sendShortcutAria")
                              }
                            >
                              {isStopping ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : isSending ? (
                                <Square className="h-4 w-4" />
                              ) : (
                                <ArrowUp className="h-4 w-4" strokeWidth={3} />
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent
                            side="top"
                            align="end"
                            className="text-[11px]"
                          >
                            {isSending ? (
                              <span>{t("stopButtonLabel")}</span>
                            ) : (
                              <span className="flex items-center gap-1">
                                <Command className="h-3.5 w-3.5" />
                                <span className="text-[11px] font-medium">
                                  +
                                </span>
                                <span>Enter</span>
                              </span>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                  <div className="flex items-center gap-4">
                    {isGitRepository ? (
                      <TooltipProvider delayDuration={120}>
                        <Tooltip>
                          <DropdownMenu>
                            <TooltipTrigger asChild>
                              <DropdownMenuTrigger disabled={isSending} asChild>
                                <button
                                  type="button"
                                  disabled={isSending}
                                  className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  <Laptop className="h-3 w-3" />
                                  <span>
                                    {useWorktree ? "Worktree" : "Local"}
                                  </span>
                                  <ChevronDown className="h-2.5 w-2.5" />
                                </button>
                              </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <TooltipContent
                              side="bottom"
                              className="text-[11px]"
                            >
                              Worktree isolates changes, Local edits in place
                            </TooltipContent>
                            <DropdownMenuContent align="start">
                              <DropdownMenuItem
                                onClick={() => setUseWorktree(true)}
                                className="flex items-center justify-between gap-3 text-[11px]"
                              >
                                <span>Worktree</span>
                                {useWorktree ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : null}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setUseWorktree(false)}
                                className="flex items-center justify-between gap-3 text-[11px]"
                              >
                                <span>Local</span>
                                {!useWorktree ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : null}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Laptop className="h-3 w-3" />
                        <span>Local</span>
                      </div>
                    )}
                  </div>
                </div>

                {!workspacePath && !isConversationLoading ? (
                  <p className="mt-2 text-xs text-destructive">
                    {t("workspaceNotSetError")}
                  </p>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
      <RebaseDialog
        open={rebaseDialogOpen}
        onClose={() => setRebaseDialogOpen(false)}
        isRebasing={isRebasing}
        branches={branches}
        isLoadingBranches={isLoadingBranches}
        initialTargetBranch={undefined}
        initialUpstreamBranch={undefined}
        onConfirm={handleRebaseConfirm}
      />
    </>
  );
};
