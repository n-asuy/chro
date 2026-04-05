import { useProjectContext } from "@/files/context/project-context";
import { useFilesStore } from "@/files/state/files-store";
import { useBranchStatus } from "@/hooks/use-branch-status";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  extractFilesFromDataTransfer,
  useGlobalFileDrop,
} from "@/hooks/use-global-file-drop";
import { useRebase } from "@/hooks/use-rebase";
import { useLanguage } from "@/i18n";
import { updateTaskTitle } from "@/kanban/state/task-store";
import { desktopFetch, getBackendBaseUrl } from "@/lib/backend-client";
import { cn } from "@/lib/cn";
import {
  type BaseCodingAgent,
  type ExecutorConfigs,
  type ExecutorProfileId,
  fetchExecutorProfile,
} from "@/lib/executor-client";
import { generateTaskTranscript } from "@/lib/project-client";
import { useSettingsModal } from "@/settings/components/settings-modal-provider";
import { ResizableSidebar } from "@/sidebar/resizable-sidebar";
import { Button } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { toast } from "@chro/ui/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  GitBranch,
  Image as ImageIcon,
  Laptop,
  Search,
} from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AgentUserQuestionHandle } from "./components/agent-user-question";
import type { GitBranch as GitBranchType } from "./components/branch-selector";
import { ConflictBanner } from "./components/conflict-banner";
import { DiffViewerPanel } from "./components/diff-viewer-panel";
import { ImageUploadPreviewList } from "./components/image-upload-preview-list";
import type { AtPopoverHandle } from "./components/prompt-editor/at-popover";
import {
  RebaseDialog,
  type RebaseDialogResult,
} from "./components/rebase-dialog";
import { SessionEmptyState } from "./components/session-empty-state";
import { SessionHeader } from "./components/session-header";
import {
  AgentUserQuestionWithEditorState,
  PromptEditorWithPopover,
  SendButtonWithState,
} from "./components/session-input-controls";
import { SessionSidebarContent } from "./components/session-sidebar-content";
import { TaskConversation } from "./components/task-conversation";
import { isWorktreeExecutionPath } from "./domain/execution-mode";
import {
  useArchivedSessions,
  useDiffStream,
  useProjectTasksStream,
  useSessionExecutionOptions,
  useSessionSidebarState,
  useSingleSessionController,
} from "./hooks";
import { useImageUploads } from "./hooks/use-image-uploads";
import { usePromptEditorHandle } from "./hooks/use-prompt-editor";
import type { PreparedPromptPayload } from "./hooks/use-single-session-controller";
import {
  QUESTIONS_SKIPPED_MESSAGE,
  useUserQuestionStore,
} from "./state/user-question-store";
import type { TaskAttempt } from "./types";
import type { StoredTask, UiEventMessage } from "./types";
import { formatContextForPrompt } from "./types/context";
import {
  SESSION_DRAG_DATA_TYPE,
  parseSessionDragPayload,
} from "./utils/session-dnd";

const SESSION_SIDEBAR_STORAGE_KEY = "desktop:session-sidebar-width";
const SESSION_SIDEBAR_DEFAULT_WIDTH = 280;
const DEFAULT_EXECUTORS: BaseCodingAgent[] = ["CLAUDE_CODE", "CODEX"];

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

const createPerfRequestId = (): string => {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `perf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const normalizeSessionErrorMessage = (message: string): string =>
  message.replace(/^bad request:\s*/i, "").trim();

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
    console.warn("[session] Failed to parse executor profile", error);
    return null;
  }
};

type SingleAgentSessionViewProps = {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
};

export function SingleAgentSessionView({
  sidebarCollapsed: externalSidebarCollapsed,
  onToggleSidebar: externalToggleSidebar,
}: SingleAgentSessionViewProps = {}) {
  const { open: openSettingsModal } = useSettingsModal();
  const { t } = useLanguage();
  const { workspacePath: workspace, isLoading: isProjectLoading } =
    useProjectContext();
  const navigateToWikilink = useFilesStore((state) => state.navigateToWikilink);
  const navigate = useNavigate();

  // Get projectId, taskId, runId from route params
  // Routes: /projects/[projectId]/session, /projects/[projectId]/session/[taskId], /projects/[projectId]/session/[taskId]/[runId]
  const params = useParams({ strict: false }) as {
    projectId?: string;
    taskId?: string;
    runId?: string;
  };
  const routeProjectId = params.projectId ?? null;
  const routeTaskId = params.taskId ?? null;
  const routeRunId = params.runId ?? null;
  const isSessionMountedRef = useRef(true);
  const latestRouteProjectIdRef = useRef<string | null>(routeProjectId);

  const previousWorkspaceRef = useRef<string | null | undefined>(undefined);

  // Current task run container ref (worktree path for image uploads)
  const [currentContainerRef, setCurrentContainerRef] = useState<string | null>(
    null,
  );

  // UI state — prompt editor handle (non-reactive, no re-renders on typing)
  const editor = usePromptEditorHandle();
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const atPopoverRef = useRef<AtPopoverHandle>(null);
  // Use optimisticSending only during the brief window between API call and server update
  const [optimisticSending, setOptimisticSending] = useState(false);
  // Track stopping state for immediate UI feedback
  const [isStopping, setIsStopping] = useState(false);
  const [diffViewerOpen, setDiffViewerOpen] = useState(false);
  const [rebaseDialogOpen, setRebaseDialogOpen] = useState(false);
  const [isMergingDiffs, setIsMergingDiffs] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [isAbortingConflicts, setIsAbortingConflicts] = useState(false);
  const [pendingSessionDrops, setPendingSessionDrops] = useState(0);
  const [branches, setBranches] = useState<GitBranchType[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [executorProfileId, setExecutorProfileId] =
    useState<ExecutorProfileId | null>(null);
  const [executorConfigs, setExecutorConfigs] =
    useState<ExecutorConfigs | null>(null);
  const [executorProfileLoading, setExecutorProfileLoading] = useState(true);
  const [sessionExecutorProfile, setSessionExecutorProfile] =
    useState<ExecutorProfileId | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const questionRef = useRef<AgentUserQuestionHandle>(null);

  useEffect(() => {
    latestRouteProjectIdRef.current = routeProjectId;
  }, [routeProjectId]);

  useEffect(() => {
    // Keep this ref in sync with actual mount state.
    // In StrictMode (dev), effects run cleanup+setup twice on mount,
    // so we must explicitly set it to true in setup.
    isSessionMountedRef.current = true;
    return () => {
      isSessionMountedRef.current = false;
    };
  }, []);

  const addErrorMessage = useCallback((message: string) => {
    const normalizedMessage = normalizeSessionErrorMessage(message);
    console.error("[SingleAgentSession] Error:", normalizedMessage);
    toast({
      title: normalizedMessage,
      variant: "warning",
    });
  }, []);

  const {
    sessionSidebarWidth,
    sessionSidebarCollapsed,
    sessionSidebarPeek,
    setSessionSidebarWidth,
    toggleSessionSidebarCollapsed,
    toggleSessionSidebarPeek,
  } = useSessionSidebarState({
    defaultWidth: SESSION_SIDEBAR_DEFAULT_WIDTH,
    storageKey: SESSION_SIDEBAR_STORAGE_KEY,
    externalSidebarCollapsed,
    externalToggleSidebar,
  });

  const {
    useWorktree,
    setUseWorktree,
    isGitRepository,
    baseBranch,
    setBaseBranch,
    baseBranchCandidates,
    isLoadingBaseBranches,
    baseBranchSearch,
    setBaseBranchSearch,
    filteredBaseBranches,
    isInitializingGit,
    handleInitGitRepo,
  } = useSessionExecutionOptions({
    routeProjectId,
    addErrorMessage,
  });

  // Archived sessions state
  const { archiveSession, restoreSession, isArchived } = useArchivedSessions();

  // Session state
  const activeTaskId = routeTaskId;
  const routeTaskRunId = routeRunId;
  // Current attempt for conversation
  const [currentAttempt, setCurrentAttempt] = useState<TaskAttempt | null>(
    null,
  );
  // Guard against stale attempt state from a previously opened task.
  // During route switches, currentAttempt can briefly point to another task.
  const taskRunId =
    routeTaskRunId ??
    (currentAttempt?.task_id === activeTaskId ? currentAttempt.id : null);

  // User question state from store
  const pendingQuestionsMap = useUserQuestionStore((s) => s.pendingQuestions);
  const setPendingQuestions = useUserQuestionStore(
    (s) => s.setPendingQuestions,
  );
  const setQuestionResult = useUserQuestionStore((s) => s.setResult);
  const pendingQuestions = taskRunId
    ? pendingQuestionsMap.get(taskRunId) ?? null
    : null;

  // Ref to track the active taskRunId for cancellation
  // This is needed because URL params may not update immediately after sending
  const activeTaskRunIdRef = useRef<string | null>(null);
  const taskRunLoadTokenRef = useRef(0);
  const [currentTaskRunTargetBranch, setCurrentTaskRunTargetBranch] = useState<
    string | null
  >(null);
  const [forceNewAttempt, setForceNewAttempt] = useState<boolean | null>(false);
  const shouldForceNewAttempt = forceNewAttempt === true;
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

  // Navigation helpers for URL-based state management
  const navigateToSession = useCallback(
    (taskId?: string | null, runId?: string | null) => {
      if (!routeProjectId) return;
      if (taskId && runId) {
        navigate({
          to: "/projects/$projectId/session/$taskId/$runId",
          params: { projectId: routeProjectId, taskId, runId },
        });
      } else if (taskId) {
        navigate({
          to: "/projects/$projectId/session/$taskId/",
          params: { projectId: routeProjectId, taskId },
        });
      } else {
        navigate({
          to: "/projects/$projectId/session/",
          params: { projectId: routeProjectId },
        });
      }
    },
    [routeProjectId, navigate],
  );

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
        console.warn("[session] Failed to load executor profile", error);
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

  const {
    tasks: streamedTasks,
    tasksById: streamedTasksById,
    isLoading: isTasksLoading,
    error: tasksStreamError,
  } = useProjectTasksStream({
    projectId: routeProjectId,
    enabled: Boolean(routeProjectId),
  });

  const isSessionsLoading = isTasksLoading;
  const sessionsError = tasksStreamError;

  // Use streamedTasksById for O(1) lookup instead of find()
  const activeTask = useMemo(
    () => (activeTaskId ? streamedTasksById[activeTaskId] ?? null : null),
    [streamedTasksById, activeTaskId],
  );
  useDocumentTitle(activeTask?.title ?? null);

  const isTaskRunning = Boolean(activeTask?.active_session_id);
  // Combined flag: server says running OR we just sent a request (optimistic)
  const isSending = isTaskRunning || optimisticSending;
  const isAttachingSession = pendingSessionDrops > 0;
  const canSend =
    Boolean(activeTaskId || workspace) && !isSending && !isAttachingSession;
  const isExecutorLocked = Boolean(taskRunId) || isSending;

  // Keep mode selector in sync with the currently loaded run.
  useEffect(() => {
    if (!workspace || !currentContainerRef) {
      return;
    }
    setUseWorktree(isWorktreeExecutionPath(currentContainerRef, workspace));
  }, [currentContainerRef, workspace]);

  // Fail-safe: release optimistic lock once server no longer marks the task running.
  useEffect(() => {
    if (!isTaskRunning && optimisticSending) {
      setOptimisticSending(false);
    }
  }, [isTaskRunning, optimisticSending]);

  const diffStream = useDiffStream({
    taskRunId,
    enabled: Boolean(taskRunId),
  });

  // Image uploads
  const formatUploadError = useCallback(
    (file: File, error: unknown) => {
      const detail =
        error instanceof Error ? error.message : t("internalError");
      return t("imageUploadFailed", { name: file.name, error: detail });
    },
    [t],
  );

  const getUploadTarget = useCallback(() => {
    if (taskRunId && !shouldForceNewAttempt) {
      return { type: "taskRun" as const, taskRunId };
    }
    return { type: "global" as const };
  }, [shouldForceNewAttempt, taskRunId]);

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
    addErrorMessage,
    formatUploadError,
  });

  const isUploading = uploadItems.some((item) => item.status === "uploading");

  // The useProjectTasksStream hook handles all real-time updates automatically

  // Full reset for new session
  const handleFullReset = useCallback(() => {
    // Invalidate any in-flight /runs resolution tied to previous route state.
    taskRunLoadTokenRef.current += 1;
    setCurrentTaskRunTargetBranch(null);
    setCurrentContainerRef(null);
    setUseWorktree(true);
    setForceNewAttempt(false);
    setCurrentAttempt(null);
    setSessionExecutorProfile(executorProfileId);
    setOptimisticSending(false);
    editor.clear();
    // Clear active taskRunId ref
    activeTaskRunIdRef.current = null;
    // Note: activeTaskId and taskRunId are derived from URL, so navigation clears them
  }, [executorProfileId]);

  // Handle workspace change - reset session state when project changes
  useEffect(() => {
    if (isProjectLoading) {
      return;
    }

    if (previousWorkspaceRef.current === workspace) {
      return;
    }

    if (
      previousWorkspaceRef.current !== undefined &&
      previousWorkspaceRef.current !== workspace
    ) {
      handleFullReset();
    }

    previousWorkspaceRef.current = workspace;
  }, [handleFullReset, workspace, isProjectLoading]);

  // Listen for UI events
  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    const httpUrl = `${baseUrl}/rpc/events`;
    const wsUrl = httpToWs(httpUrl);
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as UiEventMessage;
        if (
          payload?.type === "ui_event" &&
          payload.payload?.kind === "open_settings"
        ) {
          openSettingsModal();
        }
      } catch (error) {
        console.warn("[desktop] Failed to parse ui_event", error);
      }
    };

    ws.onerror = () => {
      console.warn("[desktop] UI event stream WebSocket error");
    };

    return () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    };
  }, [openSettingsModal]);

  // Calculate new session URL
  const newSessionUrl = useMemo(() => {
    if (!routeProjectId) return "/";
    return `/projects/${routeProjectId}/session/`;
  }, [routeProjectId]);

  // Start new session handler
  const handleStartNewSession = useCallback(() => {
    handleFullReset();
    navigateToSession(null, null);
    setForceNewAttempt(true);
    editor.clear();
    clearUploadItems();
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    // Focus prompt editor after reset (setTimeout to ensure DOM is ready)
    setTimeout(() => {
      editor.focus();
    }, 50);
  }, [handleFullReset, navigateToSession, clearUploadItems, fileInputRef]);

  // Handle new session link click (only reset state if not opening in new tab)
  const handleNewSessionClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      // If command/ctrl key is pressed, let the Link handle it (open in new tab)
      if (event.metaKey || event.ctrlKey) {
        return;
      }
      // For normal clicks, prevent default navigation and use our handler
      event.preventDefault();
      handleStartNewSession();
    },
    [handleStartNewSession],
  );

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

  const { loadTaskRunData, submitPrompt, handleCancel } =
    useSingleSessionController({
      workspace,
      routeProjectId,
      activeTaskId,
      taskRunId,
      forceNewAttempt: shouldForceNewAttempt,
      useWorktree,
      baseBranch,
      sessionExecutorSelection,
      executorProfileId,
      isSending,
      isStopping,
      t,
      editor,
      isSessionMountedRef,
      latestRouteProjectIdRef,
      activeTaskRunIdRef,
      taskRunLoadTokenRef,
      parseExecutorProfileId,
      setCurrentTaskRunTargetBranch,
      setCurrentContainerRef,
      setUseWorktree,
      setSessionExecutorProfile,
      setCurrentAttempt,
      setOptimisticSending,
      setIsStopping,
      addErrorMessage,
      navigateToSession,
      createPerfRequestId,
    });

  // Load task handler (user clicks on a task in the sidebar)
  const handleLoadTask = useCallback(
    (task: StoredTask, selectedRunId?: string) => {
      if (task.id === activeTaskId && !selectedRunId) {
        return;
      }
      handleFullReset();
      setForceNewAttempt(null);
      clearUploadItems();
      editor.clear();
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      // Route change first; run resolution is handled by route sync effect.
      navigateToSession(task.id, selectedRunId ?? null);
    },
    [
      activeTaskId,
      handleFullReset,
      clearUploadItems,
      fileInputRef,
      navigateToSession,
    ],
  );

  useEffect(() => {
    if (!routeTaskId) {
      return;
    }

    if (
      !routeRunId &&
      currentAttempt?.task_id === routeTaskId &&
      activeTaskRunIdRef.current
    ) {
      setForceNewAttempt(false);
      return;
    }

    if (
      routeRunId &&
      activeTaskRunIdRef.current === routeRunId &&
      currentAttempt?.task_id === routeTaskId
    ) {
      setForceNewAttempt(false);
      return;
    }

    const requestId = createPerfRequestId();
    taskRunLoadTokenRef.current += 1;
    const loadToken = taskRunLoadTokenRef.current;
    setForceNewAttempt(null);
    // Resolve run data for the current route. When runId is omitted,
    // select latest/active run into local state without changing URL.
    void loadTaskRunData(routeTaskId, routeRunId ?? undefined, {
      requestId,
      loadToken,
    })
      .then((targetRun) => {
        if (
          !isSessionMountedRef.current ||
          loadToken !== taskRunLoadTokenRef.current
        ) {
          return;
        }
        setForceNewAttempt(targetRun === null);
      })
      .catch((error) => {
        if (
          !isSessionMountedRef.current ||
          loadToken !== taskRunLoadTokenRef.current
        ) {
          return;
        }
        console.error("[session] Failed to load task runs", error);
        setForceNewAttempt(false);
      });
  }, [routeTaskId, routeRunId, currentAttempt?.task_id, loadTaskRunData]);

  const buildPromptPayload = useCallback((): PreparedPromptPayload | null => {
    const contextPrefix = formatContextForPrompt(editor.getContextEntries());
    const imagesMarkdown = getImagesMarkdown();
    const text = editor.getText().trim();
    const prompt = [contextPrefix, imagesMarkdown, text]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!prompt) {
      return null;
    }
    return {
      prompt,
      imageIds: getImageIds(),
    };
  }, [editor, getImageIds, getImagesMarkdown]);

  // Send handler
  const handleSend = useCallback(async () => {
    if (editor.isEmpty()) {
      return;
    }

    if (!workspace && !activeTaskId) {
      addErrorMessage(t("workspaceNotSetError"));
      return;
    }

    if (isUploading || isAttachingSession) return;

    const payload = buildPromptPayload();
    if (!payload) {
      return;
    }

    if (isSending) {
      return;
    }

    // Clear prompt immediately before toggling sending state.
    editor.clearWithSnapshot();
    clearUploadItems();
    await submitPrompt(payload, { restoreOnError: true });
  }, [
    editor,
    workspace,
    addErrorMessage,
    t,
    isUploading,
    isAttachingSession,
    buildPromptPayload,
    isSending,
    clearUploadItems,
    submitPrompt,
    activeTaskId,
  ]);

  // User question handlers
  const handleQuestionAnswer = useCallback(
    async (answers: Record<string, string>) => {
      if (!pendingQuestions || !taskRunId) return;

      const { toolUseId } = pendingQuestions;

      try {
        // Store result immediately for real-time UI update
        setQuestionResult(toolUseId, answers);

        // Respond via approval API
        await desktopFetch(
          `/rpc/approvals/${encodeURIComponent(toolUseId)}/respond`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: { status: "approved" },
              answers,
            }),
          },
        );

        // Clear pending question
        setPendingQuestions(taskRunId, null);
      } catch (error) {
        console.error("[handleQuestionAnswer] Failed to submit answer", error);
      }
    },
    [pendingQuestions, taskRunId, setQuestionResult, setPendingQuestions],
  );

  const handleQuestionSkip = useCallback(async () => {
    if (!pendingQuestions || !taskRunId) return;

    const { toolUseId } = pendingQuestions;

    try {
      // Store skipped result
      setQuestionResult(toolUseId, { error: QUESTIONS_SKIPPED_MESSAGE });

      // Respond via approval API with denied status
      await desktopFetch(
        `/rpc/approvals/${encodeURIComponent(toolUseId)}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: { status: "denied", reason: QUESTIONS_SKIPPED_MESSAGE },
          }),
        },
      );

      // Clear pending question
      setPendingQuestions(taskRunId, null);
    } catch (error) {
      console.error("[handleQuestionSkip] Failed to skip question", error);
    }
  }, [pendingQuestions, taskRunId, setQuestionResult, setPendingQuestions]);

  // Stream finished handler - called when task run completes
  // The actual isTaskRunning state comes from server's active_session_id
  const handleStreamFinished = useCallback(() => {
    setOptimisticSending(false);
  }, []);

  const { status: branchStatus, refetch: refetchBranchStatus } =
    useBranchStatus({
      taskRunId,
      enabled: Boolean(taskRunId),
      pollInterval: 10000,
    });

  // Merge diffs handler
  const handleMergeDiffs = useCallback(async () => {
    if (!taskRunId) {
      addErrorMessage(t("diffMergeErrorMessage"));
      return;
    }
    setIsMergingDiffs(true);
    try {
      await desktopFetch<{
        merge_commit: string;
        target_branch: string;
      }>(`/rpc/task-runs/${encodeURIComponent(taskRunId)}/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // Set success state temporarily
      setMergeSuccess(true);
      setTimeout(() => setMergeSuccess(false), 2000);
      // Refetch branch status to update commits_ahead immediately
      void refetchBranchStatus();
    } catch (error) {
      console.error("[mergeDiffs] failed to merge diffs", error);
      if (error instanceof Error && error.message) {
        addErrorMessage(error.message);
      } else {
        addErrorMessage(t("diffMergeErrorMessage"));
      }
    } finally {
      setIsMergingDiffs(false);
    }
  }, [addErrorMessage, refetchBranchStatus, t, taskRunId]);

  // Rebase handlers
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

  // Fetch branches when rebase dialog opens
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

  // Conflict handlers
  const handleAbortConflicts = useCallback(async () => {
    if (!taskRunId || isAbortingConflicts) return;
    setIsAbortingConflicts(true);
    try {
      await desktopFetch(
        `/rpc/task-runs/${encodeURIComponent(taskRunId)}/conflicts/abort`,
        { method: "POST" },
      );
      void refetchBranchStatus();
    } catch (error) {
      console.error("[session] Failed to abort conflicts", error);
      if (error instanceof Error && error.message) {
        addErrorMessage(error.message);
      }
    } finally {
      setIsAbortingConflicts(false);
    }
  }, [taskRunId, isAbortingConflicts, refetchBranchStatus, addErrorMessage]);

  const handleOpenInEditor = useCallback(() => {
    // Editor integration is not implemented yet.
  }, []);

  const handleTitleChange = useCallback(
    async (newTitle: string) => {
      if (!activeTaskId) return;
      await updateTaskTitle(activeTaskId, newTitle);
    },
    [activeTaskId],
  );

  // Input handlers (keyDown, composition moved to PromptEditor / usePromptEditor)
  const handleDropFiles = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const sessionPayload = parseSessionDragPayload(
        event.dataTransfer.getData(SESSION_DRAG_DATA_TYPE),
      );
      if (sessionPayload) {
        if (!workspace) {
          addErrorMessage(t("workspaceNotSetError"));
          return;
        }

        const dropX = event.clientX;
        const dropY = event.clientY;
        editor.setCursorFromPoint(dropX, dropY);
        setPendingSessionDrops((count) => count + 1);

        void generateTaskTranscript(
          sessionPayload.taskId,
          workspace,
          currentContainerRef,
        )
          .then((filePath) => {
            editor.addFilePart(filePath, true, sessionPayload.branch);
          })
          .catch((error) => {
            console.error("[session] Failed to attach dragged session", error);
            addErrorMessage(
              error instanceof Error ? error.message : t("internalError"),
            );
          })
          .finally(() => {
            if (!isSessionMountedRef.current) {
              return;
            }
            setPendingSessionDrops((count) => Math.max(0, count - 1));
          });
        return;
      }

      const files = extractFilesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      handleFiles(files);
    },
    [workspace, editor, currentContainerRef, addErrorMessage, t, handleFiles],
  );

  const handlePasteFiles = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
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

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [currentAttempt, isSending]);

  // Focus prompt editor when task/run session route changes
  useEffect(() => {
    // Small delay to ensure DOM is ready after session switch
    const timeoutId = setTimeout(() => {
      editor.focus();
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [activeTaskId, routeTaskRunId, editor]);

  // Note: activeTask, isTaskRunning, isSending, canSend are defined earlier for use in callbacks
  const activeTaskBranch = activeTask?.branch?.trim() || null;
  const activeTaskTitle = useMemo(() => {
    const title = activeTask?.title?.trim();
    return title && title.length > 0 ? title : null;
  }, [activeTask]);
  // isSendButtonDisabled is now computed inside PromptInputArea via store subscription
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
  const commitsAhead = branchStatus?.commits_ahead ?? 0;
  // Use commits_behind for diff action availability.
  const commitsBehind = branchStatus?.commits_behind ?? 0;
  // Conflict state
  const hasConflicts = (branchStatus?.conflicted_files?.length ?? 0) > 0;
  const isRebaseInProgress = branchStatus?.is_rebase_in_progress ?? false;
  const conflictOp = branchStatus?.conflict_op ?? null;
  const conflictedFiles = branchStatus?.conflicted_files ?? [];

  // Keep merge/rebase availability checks aligned with branch status.
  // Merge: disabled only during mutation
  const canMergeDiffs = Boolean(
    taskRunId &&
      hasDiffs &&
      !isMergingDiffs &&
      (commitsAhead > 0 || mergeSuccess),
  );

  // Rebase requires Git branch context and pending work against the base branch.
  const canRebase = Boolean(
    taskRunId &&
      hasDiffs &&
      branchStatus?.target_branch &&
      !isRebasing &&
      commitsBehind > 0,
  );

  // Filter out archived tasks (now using status field)
  const sortedTasks = useMemo(
    () => streamedTasks.filter((task) => !isArchived(task)),
    [streamedTasks, isArchived],
  );

  // Archived sessions for popover
  const archivedSessions = useMemo(
    () =>
      streamedTasks
        .filter((task) => isArchived(task))
        .map((task) => ({
          id: task.id,
          title: task.title,
          archivedAt: task.updated_at,
        })),
    [streamedTasks, isArchived],
  );
  const showSessionListLoading = isSessionsLoading && sortedTasks.length === 0;

  // Render helpers
  const renderPromptContent = (
    containerClassName: string,
    inputWrapperClassName: string,
  ) => (
    <div
      className={containerClassName}
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

      <div className={cn("w-full px-4 pb-4 pt-3", inputWrapperClassName)}>
        <div className="flex flex-col gap-3 rounded-2xl border border-custom-border-200 bg-background p-4 shadow-sm focus-within:shadow-md">
          <ImageUploadPreviewList
            items={uploadItems}
            t={t}
            onRetryUpload={handleRetryUpload}
            onRemoveUpload={handleRemoveUpload}
            className="-mt-1"
          />
          <PromptEditorWithPopover
            editorHandle={editor}
            atPopoverRef={atPopoverRef}
            projectId={routeProjectId ?? null}
            workspacePath={workspace}
            containerRef={currentContainerRef}
            tasks={sortedTasks}
            atActiveIndex={atActiveIndex}
            onActiveIndexChange={setAtActiveIndex}
            disabled={!workspace && !activeTaskId}
            isAttachingSession={isAttachingSession}
            onSubmit={handleSend}
            onDrop={handleDropFiles}
            onPaste={handlePasteFiles}
            t={t}
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
                      disabled={isStopping}
                      onClick={handleSelectFiles}
                      className={cn(
                        "flex h-9 w-9 items-center justify-center rounded-[4px] text-muted-foreground transition hover:bg-muted/40 hover:text-primary",
                        uploadItems.length > 0
                          ? "bg-primary/10 text-primary"
                          : "",
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
                      isExecutorLocked ? "bg-muted/40" : "",
                      "disabled:cursor-not-allowed disabled:opacity-40",
                    )}
                  >
                    <span className="text-xs">{executorSelectorLabel}</span>
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
                        {isActive ? <Check className="h-3.5 w-3.5" /> : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex items-center gap-2">
              <SendButtonWithState
                isSending={isSending}
                isStopping={isStopping}
                canSend={canSend}
                isUploading={isUploading}
                onSend={handleSend}
                onCancel={handleCancel}
                t={t}
              />
            </div>
          </div>
        </div>

        {/* Footer Status Bar */}
        <div className="mt-3 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
          {isLoadingBaseBranches ? null : isGitRepository ? (
            <>
              <div className="flex items-center gap-4">
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <DropdownMenu>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger
                          disabled={isExecutorLocked}
                          asChild
                        >
                          <button
                            type="button"
                            disabled={isExecutorLocked}
                            className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <Laptop className="h-3 w-3" />
                            <span>{useWorktree ? "Worktree" : "Local"}</span>
                            <ChevronDown className="h-2.5 w-2.5" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-[11px]">
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
              </div>

              <div className="flex items-center gap-3">
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <DropdownMenu
                      onOpenChange={(next) => {
                        if (!next) setBaseBranchSearch("");
                      }}
                    >
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger
                          disabled={isExecutorLocked}
                          asChild
                        >
                          <button
                            type="button"
                            disabled={isExecutorLocked}
                            className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <GitBranch className="h-3 w-3" />
                            <span>From</span>
                            <span className="max-w-[120px] truncate">
                              {baseBranch ?? "main"}
                            </span>
                            <ChevronDown className="h-2.5 w-2.5" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-[11px]">
                        Base branch to start working from
                      </TooltipContent>
                      <DropdownMenuContent align="end" className="w-64">
                        <div className="p-2">
                          <div className="relative">
                            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                            <input
                              type="text"
                              placeholder="Search branches..."
                              value={baseBranchSearch}
                              onChange={(e) =>
                                setBaseBranchSearch(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  return;
                                }
                                e.stopPropagation();
                              }}
                              className="w-full rounded-sm border border-border bg-background py-1.5 pl-7 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                          </div>
                        </div>
                        <DropdownMenuSeparator />
                        <div className="max-h-48 overflow-y-auto">
                          {filteredBaseBranches.length === 0 ? (
                            <div className="p-2 text-center text-[11px] text-muted-foreground">
                              No branches found
                            </div>
                          ) : (
                            filteredBaseBranches.map((branch) => (
                              <DropdownMenuItem
                                key={branch.name}
                                onClick={() => setBaseBranch(branch.name)}
                                className="flex items-center justify-between gap-3 text-[11px]"
                              >
                                <span className="min-w-0 truncate">
                                  {branch.name}
                                </span>
                                <div className="flex flex-shrink-0 items-center gap-1">
                                  {branch.is_current && (
                                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                      current
                                    </span>
                                  )}
                                  {baseBranch === branch.name && (
                                    <Check className="h-3.5 w-3.5" />
                                  )}
                                </div>
                              </DropdownMenuItem>
                            ))
                          )}
                        </div>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </>
          ) : (
            <div className="flex w-full items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Laptop className="h-3 w-3" />
                <span>Local</span>
              </div>
              <button
                type="button"
                disabled={isInitializingGit || !routeProjectId}
                onClick={handleInitGitRepo}
                className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                <GitBranch className="h-3 w-3" />
                <span>
                  {isInitializingGit
                    ? "Initializing..."
                    : "Create git repository"}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderGlobalPrompt = () => (
    <div className="bg-background/80 backdrop-blur">
      {(hasConflicts || isRebaseInProgress) && (
        <div className="mx-auto max-w-2xl px-4 pt-4">
          <ConflictBanner
            attemptBranch={activeTaskBranch}
            baseBranch={branchStatus?.target_branch ?? undefined}
            conflictedFiles={conflictedFiles}
            onOpenEditor={handleOpenInEditor}
            onAbort={handleAbortConflicts}
            op={conflictOp}
            enableAbort={!isAbortingConflicts && !isSending}
          />
        </div>
      )}
      <div className="mx-auto w-full max-w-2xl px-4">
        {pendingQuestions && (
          <AgentUserQuestionWithEditorState
            questionRef={questionRef}
            pendingQuestions={pendingQuestions}
            onAnswer={handleQuestionAnswer}
            onSkip={handleQuestionSkip}
          />
        )}
      </div>
      {renderPromptContent(
        "mx-auto flex w-full max-w-full flex-col gap-4 py-4",
        "max-w-2xl mx-auto",
      )}
    </div>
  );

  const sessionSidebarButtonClass =
    "text-[12px] inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40";

  // This ensures follow-up messages (which create new TaskRuns) are visible
  const conversationContent = (
    <div
      className={cn("flex h-full max-w-full flex-col gap-4 min-h-0", "mx-auto")}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTaskId ? (
          <TaskConversation
            key={activeTaskId}
            taskId={activeTaskId}
            messagesEndRef={messagesEndRef}
            onWikilinkClick={navigateToWikilink}
            onFinished={handleStreamFinished}
          />
        ) : (
          <SessionEmptyState title={t("sessionEmptyHeroTitle")} />
        )}
      </div>
    </div>
  );

  return (
    <>
      <RebaseDialog
        open={rebaseDialogOpen}
        onClose={() => setRebaseDialogOpen(false)}
        isRebasing={isRebasing}
        branches={branches}
        isLoadingBranches={isLoadingBranches}
        initialTargetBranch={currentTaskRunTargetBranch ?? undefined}
        initialUpstreamBranch={currentTaskRunTargetBranch ?? undefined}
        onConfirm={handleRebaseConfirm}
      />
      <div className="flex h-full w-full justify-end bg-muted text-foreground">
        <div className="flex h-full w-full max-w-full bg-background">
          <ResizableSidebar
            width={sessionSidebarWidth}
            setWidth={setSessionSidebarWidth}
            defaultWidth={SESSION_SIDEBAR_DEFAULT_WIDTH}
            minWidth={220}
            maxWidth={400}
            isCollapsed={sessionSidebarCollapsed}
            toggleCollapsed={toggleSessionSidebarCollapsed}
            showPeek={sessionSidebarPeek}
            togglePeek={toggleSessionSidebarPeek}
            disablePeekTrigger={true}
            sidebarClassName="bg-custom-sidebar-background-90"
          >
            <SessionSidebarContent
              newSessionUrl={newSessionUrl}
              onNewSessionClick={handleNewSessionClick}
              archivedSessions={archivedSessions}
              onRestoreSession={restoreSession}
              showSessionListLoading={showSessionListLoading}
              sessionsError={sessionsError}
              sortedTasks={sortedTasks}
              activeTaskId={activeTaskId}
              onLoadTask={handleLoadTask}
              onArchiveTask={archiveSession}
              onCloseSidebar={() => toggleSessionSidebarCollapsed(true)}
              sidebarButtonClassName={sessionSidebarButtonClass}
              t={t}
            />
          </ResizableSidebar>
          <div className="flex min-w-0 flex-1 flex-col border-l border-border/60 bg-background">
            <SessionHeader
              taskId={activeTaskId}
              taskTitle={activeTaskTitle}
              taskBranch={activeTaskBranch}
              hasDiffs={hasDiffs}
              canRebase={canRebase}
              canMergeDiffs={canMergeDiffs}
              isRebasing={isRebasing}
              isMergingDiffs={isMergingDiffs}
              commitsBehind={commitsBehind}
              onOpenDiffViewer={() => setDiffViewerOpen(true)}
              onRebase={() => setRebaseDialogOpen(true)}
              onMergeDiffs={handleMergeDiffs}
              onTitleChange={activeTaskId ? handleTitleChange : undefined}
              isSidebarCollapsed={sessionSidebarCollapsed}
              onOpenSidebar={() => toggleSessionSidebarCollapsed(false)}
              t={t}
            />
            <main className="flex-1 overflow-hidden">
              {diffViewerOpen && (
                <DiffViewerPanel
                  onClose={() => setDiffViewerOpen(false)}
                  diffs={diffViewerItems}
                  taskRunId={taskRunId}
                />
              )}
              <div
                className={cn(
                  "flex h-full flex-col overflow-hidden",
                  diffViewerOpen && "hidden",
                )}
              >
                <div className="flex-1 overflow-hidden">
                  {conversationContent}
                </div>
              </div>
            </main>
            {renderGlobalPrompt()}
          </div>
        </div>
      </div>
    </>
  );
}

export default SingleAgentSessionView;
