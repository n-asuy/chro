import { AgentLogo } from "@/components/agent-logo";
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
import {
  type ModelOption,
  REASONING_OPTIONS,
  RUNTIME_DEFAULT_LABEL,
  getModelLabel,
  getModelOptions,
  getReasoningLabel,
  runtimeSupportsReasoning,
} from "@/lib/agent-runtime-options";
import { desktopFetch, getBackendBaseUrl } from "@/lib/backend-client";
import { cn } from "@/lib/cn";
import {
  type BaseCodingAgent,
  type ExecutorConfigs,
  type ExecutorProfileId,
  type ReasoningEffort,
  fetchExecutorProfile,
  fetchPiModels,
} from "@/lib/executor-client";
import { useFlag } from "@/lib/feature-flags-store";
import { slugOrId } from "@/lib/slug";
import { isUuidIdentifier } from "@/lib/uuid";
import { useSettingsModal } from "@/settings/components/settings-modal-provider";
import { ResizableSidebar } from "@/sidebar/resizable-sidebar";
import { updateTaskTitle } from "@/tasks/task-api";
import { ProjectOverview } from "@/workspace-layout/components/project-overview";
import {
  useOptionalTab,
  useOptionalTabKind,
  useResolvedRunId,
  useResolvedTaskId,
} from "@/workspace-layout/hooks/use-tab-params";
import {
  getOpenInErrorDescription,
  getSelectedOpenInOption,
  openWorkspaceWithOption,
} from "@/workspace-layout/lib/open-in";
import { Button, buttonVariants } from "@chro/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  FolderOpen,
  Image as ImageIcon,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import {
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AgentUserQuestion } from "./components/agent-user-question";
import type { GitBranch as GitBranchType } from "./components/branch-selector";
import { ConflictBanner } from "./components/conflict-banner";
import { ConversationFindBar } from "./components/conversation-find-bar";
import { ConversationMessageNav } from "./components/conversation-message-nav";
import {
  EnvironmentPopover,
  type RebaseConfirmResult,
} from "./components/environment-popover";
import { NewSessionExecutionControls } from "./components/execution-options-controls";
// DiffViewerPanel is no longer rendered inline; the "Open Diff" header
// action now opens a dedicated diff tab via the layout store. The panel
// itself is rendered by DiffTabBody under workspace-layout/registry.
import { ImageUploadPreviewList } from "./components/image-upload-preview-list";
import type { AtPopoverHandle } from "./components/prompt-editor/at-popover";
import { SessionHeader } from "./components/session-header";
import {
  PromptEditorWithPopover,
  SendButtonWithState,
} from "./components/session-input-controls";
import { SessionReferencesPopover } from "./components/session-references-popover";
import { TaskConversation } from "./components/task-conversation";
import { useOptionalProjectTasks } from "./context/project-tasks-context";
import { ConversationActionsContext } from "./conversation-actions";
import {
  isWorktreeExecutionPath,
  resolveUseWorktreeForRun,
} from "./domain/execution-mode";
import { resolveExecutorSettingLocks } from "./domain/executor-setting-locks";
import { selectTargetTaskRun } from "./domain/task-run-selection";
import {
  useArchivedSessions,
  useConversationHistory,
  useDiffStream,
  useJsonPatchWsStream,
  useProjectTasksStream,
  usePromptDraftPersistence,
  useSessionExecutionOptions,
  useSessionRunController,
  useSessionSidebarState,
  useSessionTaskState,
  useSingleSessionController,
  useTaskRunsStream,
  useTaskSessionsStream,
} from "./hooks";
import type { LogEntryMessage } from "./hooks";
import { useComposerFileDrag } from "./hooks/use-composer-file-drag";
import { useConversationFind } from "./hooks/use-conversation-find";
import { useImageUploads } from "./hooks/use-image-uploads";
import { usePromptEditorHandle } from "./hooks/use-prompt-editor";
import type { PreparedPromptPayload } from "./hooks/use-single-session-controller";
import { usePromptEditorStore } from "./state/prompt-editor-store";
import { useTaskTitleOverridesStore } from "./state/task-title-overrides-store";
import {
  QUESTIONS_SKIPPED_MESSAGE,
  type UserQuestion,
  useUserQuestionStore,
} from "./state/user-question-store";
import type { StoredTask } from "./types";
import {
  contextEntriesToRefs,
  formatContextForPrompt,
  formatSkillContextForPrompt,
} from "./types/context";
import { AbortControllerRegistry } from "./utils/abort-controller-registry";
import {
  SESSION_DRAG_DATA_TYPE,
  parseSessionDragPayload,
} from "./utils/session-dnd";

// Stable empty document for the app-events stream: it carries no JSON-Patch
// state, only fire-and-forget `ui_event` messages handled via `onMessage`.
const EMPTY_APP_EVENTS_DOCUMENT = (): Record<string, never> => ({});

const SESSION_SIDEBAR_STORAGE_KEY = "desktop:session-sidebar-width";
const SESSION_SIDEBAR_DEFAULT_WIDTH = 280;
const DEFAULT_EXECUTORS: BaseCodingAgent[] = ["CLAUDE_CODE", "CODEX", "PI"];

// Follow-up sent when retrying a turn that aborted on a malformed tool call.
// Nudges the agent to re-issue the dropped call as a proper structured tool
// call and pick up where it stopped.
const MALFORMED_TOOL_CALL_RETRY_PROMPT =
  "Your previous tool call was malformed and did not run, so the turn stopped. Re-issue that tool call as a proper tool call and continue from where you left off.";

// Follow-up sent when retrying a turn that stopped on a server-side API error
// (rate limit, usage limit, ...). The previous turn did no work, so just nudge
// the agent to pick up where it left off.
const API_ERROR_RETRY_PROMPT =
  "The previous turn stopped on a server-side API error before doing any work. Continue from where you left off.";

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
      model: parsed.model ?? null,
      reasoning_effort: parsed.reasoning_effort ?? null,
    };
  } catch (error) {
    console.warn("[session] Failed to parse executor profile", error);
    return null;
  }
};

type SingleAgentSessionViewProps = {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  /**
   * Always render the "new session" composer, ignoring any task/run carried by
   * the route or tab. Used to embed the start-a-session surface in the project
   * Home (overview) tab and in empty panes, where the ambient URL may still
   * point at another pane's focused session.
   */
  forceNewSession?: boolean;
};

export function SingleAgentSessionView({
  sidebarCollapsed: externalSidebarCollapsed,
  onToggleSidebar: externalToggleSidebar,
  forceNewSession = false,
}: SingleAgentSessionViewProps = {}) {
  const { open: openSettingsModal } = useSettingsModal();
  const { t } = useLanguage();
  const {
    projectId: resolvedProjectId,
    projectSlug,
    workspacePath: workspace,
    isScratch,
    isLoading: isProjectLoading,
  } = useProjectContext();
  const navigateToWikilink = useFilesStore((state) => state.navigateToWikilink);
  const openFilePath = useFilesStore((state) => state.openFilePath);
  const navigate = useNavigate();
  // Route params — may contain slugs or UUIDs (backward compat).
  // Resolver hooks unify "rendered at /session/:taskId" and "rendered as a
  // session tab inside the workspace layout"; outside a tab they fall back
  // to TanStack Router useParams.
  const params = useParams({ strict: false }) as {
    projectId?: string;
    taskId?: string;
    runId?: string;
  };
  const tab = useOptionalTab();
  const tabKind = useOptionalTabKind();
  const resolvedTaskSlug = useResolvedTaskId();
  const resolvedRunSlug = useResolvedRunId();
  const routeProjectSlug = projectSlug ?? params.projectId ?? null;
  const routeProjectId =
    resolvedProjectId ??
    (isUuidIdentifier(params.projectId) ? params.projectId : null);
  const routeTaskSlug = forceNewSession ? null : resolvedTaskSlug;
  const routeRunSlug = forceNewSession ? null : resolvedRunSlug;
  // Inside a tab, do not consume mounting URL state if the tab kind doesn't
  // describe a session; this prevents stale navigations from leaking in.
  void tabKind;
  const isSessionMountedRef = useRef(true);
  const latestRouteProjectIdRef = useRef<string | null>(routeProjectId);
  const latestRouteTaskSlugRef = useRef<string | null>(routeTaskSlug ?? null);
  // Tracks in-flight send requests so every one is aborted on reset/unmount
  // (only the response is discarded; the server finishes the create either
  // way), and so a Stop pressed during the create window marks the run for
  // cancellation as soon as its id comes back.
  const abortRegistryRef = useRef<AbortControllerRegistry | null>(null);
  abortRegistryRef.current ??= new AbortControllerRegistry();
  const abortRegistry = abortRegistryRef.current;
  const requestCancelSubmission = useCallback(
    (requestId: string) => abortRegistry.requestCancel(requestId),
    [abortRegistry],
  );
  const promptScopeId = useMemo(() => {
    if (tab) return `tab:${tab.id}`;
    return [
      "route",
      routeProjectSlug ?? routeProjectId ?? "unknown-project",
      routeTaskSlug ?? "new",
      routeRunSlug ?? "latest",
    ].join(":");
  }, [routeProjectId, routeProjectSlug, routeRunSlug, routeTaskSlug, tab]);

  const previousWorkspaceRef = useRef<string | null | undefined>(undefined);

  // Current task run container ref (worktree path for image uploads)
  const [currentContainerRef, setCurrentContainerRef] = useState<string | null>(
    null,
  );

  // UI state — prompt editor handle (non-reactive, no re-renders on typing)
  const editor = usePromptEditorHandle(promptScopeId);
  usePromptDraftPersistence(editor);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const atPopoverRef = useRef<AtPopoverHandle>(null);
  const setPromptPopover = usePromptEditorStore((s) => s.setPopover);
  // Open the "@" context popover directly into a category (from the "+" menu).
  const openContextCategory = useCallback(
    (category: "skills" | "files" | "sessions") => {
      setPromptPopover(editor.scopeId, "at");
      atPopoverRef.current?.openCategory(category);
      // Keep the editor focused so arrow-key navigation works and the
      // inserted pill lands at the cursor (the dropdown returns focus to
      // its trigger on close, so restore it on the next tick).
      setTimeout(() => editor.focus(), 0);
    },
    [editor, setPromptPopover],
  );
  const referencesPopoverEnabled = useFlag("session_references_popover");
  const [environmentPopoverOpen, setEnvironmentPopoverOpen] = useState(false);
  const [isMergingDiffs, setIsMergingDiffs] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState(false);
  const [isAbortingConflicts, setIsAbortingConflicts] = useState(false);
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);
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

  useEffect(() => {
    latestRouteProjectIdRef.current = routeProjectId;
  }, [routeProjectId]);

  useEffect(() => {
    latestRouteTaskSlugRef.current = routeTaskSlug ?? null;
  }, [routeTaskSlug]);

  useEffect(() => {
    // Keep this ref in sync with actual mount state.
    // In StrictMode (dev), effects run cleanup+setup twice on mount,
    // so we must explicitly set it to true in setup.
    isSessionMountedRef.current = true;
    return () => {
      isSessionMountedRef.current = false;
      abortRegistry.abortAll();
    };
  }, [abortRegistry]);

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
      PI: t("mcpExecutorOptionPi"),
    }),
    [t],
  );
  const sessionExecutorSelection = sessionExecutorProfile ?? executorProfileId;
  const executorDisplayLabel = useMemo(() => {
    if (!sessionExecutorSelection) {
      return t("agentProfileUnknown");
    }
    return (
      executorLabels[sessionExecutorSelection.executor] ??
      sessionExecutorSelection.executor
    );
  }, [executorLabels, sessionExecutorSelection, t]);

  // Navigation helpers — accepts slugs (or UUIDs for backward compat)
  const navigateToSession = useCallback(
    (taskSlug?: string | null, runSlug?: string | null) => {
      if (!routeProjectSlug) return;
      if (taskSlug && runSlug) {
        navigate({
          to: "/projects/$projectId/session/$taskId/$runId",
          params: {
            projectId: routeProjectSlug,
            taskId: taskSlug,
            runId: runSlug,
          },
        });
      } else if (taskSlug) {
        navigate({
          to: "/projects/$projectId/session/$taskId",
          params: { projectId: routeProjectSlug, taskId: taskSlug },
        });
      } else {
        navigate({
          to: "/projects/$projectId/session",
          params: { projectId: routeProjectSlug },
        });
      }
    },
    [routeProjectSlug, navigate],
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

  const sharedProjectTasks = useOptionalProjectTasks();
  const fallbackProjectTasks = useProjectTasksStream({
    projectId: routeProjectId,
    enabled: Boolean(routeProjectId) && !sharedProjectTasks,
  });
  const projectTasks = sharedProjectTasks ?? fallbackProjectTasks;
  // Feed the RAW stream tasks (no optimistic overlay) into useSessionTaskState.
  // Its pending-settlement check must compare against the real stream; using
  // the overlaid tasks lets a finished pending settle against its own
  // synthesized row and clear itself before the real task arrives, which made a
  // just-created session vanish from the sidebar until reload. The shared
  // provider exposes `rawTasks`; the fallback stream is already un-overlaid.
  const streamedTasks = sharedProjectTasks
    ? sharedProjectTasks.rawTasks
    : fallbackProjectTasks.tasks;

  const isSessionsLoading = projectTasks.isLoading;
  const sessionsError = projectTasks.error;

  const {
    tasks: displayedTasks,
    tasksById,
    activeTaskId,
    activeStreamTaskId,
    activeTask,
    pendingSubmission,
    beginPendingSubmission,
    resolvePendingSubmission,
    finishPendingSubmission,
    clearPendingSubmission,
  } = useSessionTaskState({
    scopeId: promptScopeId,
    projectId: routeProjectId,
    routeTaskSlug,
    streamedTasks,
  });

  const sidebarActiveTaskId = activeTaskId;

  const {
    runs: taskRuns,
    isLoading: isTaskRunsLoading,
    error: taskRunsError,
  } = useTaskRunsStream({
    taskId: activeStreamTaskId,
    enabled: Boolean(activeStreamTaskId),
  });

  const {
    sessions: taskSessions,
    isLoading: isTaskSessionsLoading,
    error: taskSessionsError,
  } = useTaskSessionsStream({
    taskId: activeStreamTaskId,
    enabled: Boolean(activeStreamTaskId),
  });

  const selectedRun = useMemo(
    () => selectTargetTaskRun(taskRuns, routeRunSlug ?? undefined),
    [routeRunSlug, taskRuns],
  );

  const activeRunRecord = useMemo(() => {
    if (pendingSubmission?.runId) {
      return taskRuns.find((run) => run.id === pendingSubmission.runId) ?? null;
    }
    return selectedRun;
  }, [pendingSubmission?.runId, selectedRun, taskRuns]);

  const taskRunId = pendingSubmission?.runId ?? activeRunRecord?.id ?? null;

  // User question state from store
  const pendingQuestionsMap = useUserQuestionStore((s) => s.pendingQuestions);
  const setPendingQuestions = useUserQuestionStore(
    (s) => s.setPendingQuestions,
  );
  const setQuestionResult = useUserQuestionStore((s) => s.setResult);
  const pendingQuestions = taskRunId
    ? pendingQuestionsMap.get(taskRunId) ?? null
    : null;
  useDocumentTitle(activeTask?.title ?? null);

  // Run state and cancellation derive from the task-runs stream as the single
  // source of truth (see useSessionRunController). The optimistic submission
  // only covers the create window before the run reaches the stream.
  const { isSending, isStopping, handleCancel } = useSessionRunController({
    taskRuns,
    isTaskRunsLoading,
    pendingSubmission,
    activeSessionHint: activeTask?.active_session_id ?? null,
    requestCancelSubmission,
    clearPendingSubmission,
  });
  // Housekeeping reclaims expired worktrees, which nulls the run's workspace
  // path. Every follow-up then dies in the backend with "workspace path missing
  // on task run", so close the composer up front and say why, rather than
  // letting the user type a prompt that can only fail.
  const isWorktreeCleanedUp = Boolean(activeRunRecord?.worktree_deleted);
  const canSend =
    Boolean(activeStreamTaskId || workspace) &&
    !isSending &&
    !isWorktreeCleanedUp;
  // The runtime (Claude↔Codex↔Pi) can't change mid-session because resume
  // ids are executor-specific. Model overrides are applied to the next run;
  // Codex carries them through thread/fork and Pi/Claude pass them on resume.
  const { runtimeLocked: isExecutorLocked, modelLocked: isModelLocked } =
    resolveExecutorSettingLocks({
      hasTaskRun: Boolean(taskRunId),
      isSending,
    });

  useEffect(() => {
    if (!activeRunRecord) {
      setCurrentTaskRunTargetBranch(null);
      setCurrentContainerRef(null);
      return;
    }

    setCurrentTaskRunTargetBranch(activeRunRecord.target_branch ?? null);
    const runExecutionPath =
      activeRunRecord.container_ref ?? activeRunRecord.workspace_path;
    setCurrentContainerRef(runExecutionPath ?? null);
    setUseWorktree(resolveUseWorktreeForRun(activeRunRecord, workspace));
  }, [activeRunRecord, setUseWorktree, workspace]);

  // Initialize the runtime/model selector from the active run's stored profile,
  // keyed on the run's identity (id + label) rather than the run object. The
  // task-runs stream re-emits a fresh object on every tick; depending on the
  // object would re-run this effect constantly and clobber a model the user
  // just picked for a follow-up. Re-syncing only when the run actually changes
  // keeps the selection stable within a run while still reflecting the correct
  // profile when switching sessions or starting a new run.
  const activeRunId = activeRunRecord?.id ?? null;
  const activeRunExecutorLabel = activeRunRecord?.executor_label ?? null;
  useEffect(() => {
    if (!activeRunId) {
      if (!activeTaskId) {
        setSessionExecutorProfile(executorProfileId);
      }
      return;
    }
    const runExecutorProfile =
      parseExecutorProfileId(activeRunExecutorLabel) ??
      executorProfileId ??
      null;
    setSessionExecutorProfile(runExecutorProfile);
  }, [activeRunId, activeRunExecutorLabel, activeTaskId, executorProfileId]);

  useEffect(() => {
    if (!activeTaskId) {
      return;
    }
    if (pendingSubmission) {
      setForceNewAttempt(false);
      return;
    }
    if (isTaskRunsLoading) {
      setForceNewAttempt(null);
      return;
    }
    setForceNewAttempt(activeRunRecord === null);
  }, [activeRunRecord, activeTaskId, isTaskRunsLoading, pendingSubmission]);

  // Keep mode selector in sync with the currently loaded run.
  useEffect(() => {
    if (!workspace || !currentContainerRef) {
      return;
    }
    setUseWorktree(isWorktreeExecutionPath(currentContainerRef, workspace));
  }, [currentContainerRef, workspace]);

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
  const handleFullReset = useCallback(
    (options?: { clearPending?: boolean; clearPrompt?: boolean }) => {
      setCurrentTaskRunTargetBranch(null);
      setCurrentContainerRef(null);
      setUseWorktree(true);
      setForceNewAttempt(false);
      setSessionExecutorProfile(executorProfileId);
      if (
        options?.clearPending !== false &&
        pendingSubmission?.requestId &&
        !pendingSubmission.runId
      ) {
        clearPendingSubmission(pendingSubmission.requestId);
      }
      if (options?.clearPrompt !== false) {
        editor.clear();
      }
      // Abort any in-flight send for this view; navigation clears the derived
      // activeTaskId/taskRunId.
      abortRegistry.abortAll();
    },
    [
      clearPendingSubmission,
      executorProfileId,
      editor,
      pendingSubmission,
      abortRegistry,
    ],
  );

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
      // During a project switch, the previous tab can render once with the
      // newly resolved project context before the layout store rebinds.
      // Clearing the editor here would delete that tab's persisted draft.
      handleFullReset({ clearPending: false, clearPrompt: false });
    }

    previousWorkspaceRef.current = workspace;
  }, [handleFullReset, workspace, isProjectLoading]);

  // Listen for app-wide UI events (e.g. an "open settings" command from the
  // tray). Shared through the stream registry so every session view reuses one
  // connection and gets automatic reconnect; this is an event bus that is
  // idle for long stretches, so it opts out of the initial-message watchdog.
  const appEventsEndpoint = useMemo(
    () => `${getBackendBaseUrl().replace(/\/$/, "")}/rpc/events`,
    [],
  );
  const handleAppEvent = useCallback(
    (msg: LogEntryMessage) => {
      if (msg.type === "ui_event" && msg.payload?.kind === "open_settings") {
        openSettingsModal();
      }
    },
    [openSettingsModal],
  );
  useJsonPatchWsStream(appEventsEndpoint, true, EMPTY_APP_EVENTS_DOCUMENT, {
    onMessage: handleAppEvent,
    expectInitialMessage: false,
  });

  // Calculate new session URL
  const newSessionUrl = useMemo(() => {
    if (!routeProjectSlug) return "/";
    return `/projects/${routeProjectSlug}/session/`;
  }, [routeProjectSlug]);

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
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
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
      setSessionExecutorProfile((prev) => {
        const base = prev ?? executorProfileId;
        // Re-selecting the active runtime keeps its variant + overrides.
        if (base?.executor === executor) {
          return base ?? { executor, variant: null };
        }
        const variant =
          executorProfileId?.executor === executor
            ? executorProfileId.variant ?? null
            : null;
        // Switching runtime invalidates the model / reasoning overrides.
        return { executor, variant, model: null, reasoning_effort: null };
      });
    },
    [executorProfileId, isExecutorLocked],
  );

  const handleModelSelect = useCallback(
    (model: string) => {
      if (isModelLocked) return;
      setSessionExecutorProfile((prev) => {
        const base = prev ?? executorProfileId;
        if (!base) return prev;
        return { ...base, model };
      });
    },
    [executorProfileId, isModelLocked],
  );

  const handleReasoningSelect = useCallback(
    (reasoning: ReasoningEffort) => {
      if (isExecutorLocked) return;
      setSessionExecutorProfile((prev) => {
        const base = prev ?? executorProfileId;
        if (!base) return prev;
        return { ...base, reasoning_effort: reasoning };
      });
    },
    [executorProfileId, isExecutorLocked],
  );

  // The runtime/model selector is a two-step menu: pick the runtime first, then
  // pick a model from that runtime's own list. Mixing both in one flat list is
  // confusing (and pi's model list is huge), so we navigate between the two
  // steps in place instead of closing on the first click.
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [runtimeMenuView, setRuntimeMenuView] = useState<"runtime" | "model">(
    "runtime",
  );
  // Free-text filter for the model step (pi exposes hundreds of models).
  const [modelQuery, setModelQuery] = useState("");
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const handleRuntimeMenuOpenChange = useCallback(
    (open: boolean) => {
      setRuntimeMenuOpen(open);
      setModelQuery("");
      if (open) {
        // Locked runtime (mid-session) only allows model changes, so jump
        // straight to the model step; otherwise start at runtime selection.
        setRuntimeMenuView(isExecutorLocked ? "model" : "runtime");
      }
    },
    [isExecutorLocked],
  );
  const handleRuntimePick = useCallback(
    (executor: BaseCodingAgent) => {
      handleExecutorSelect(executor);
      setModelQuery("");
      setRuntimeMenuView("model");
    },
    [handleExecutorSelect],
  );
  const handleModelStepBack = useCallback(() => {
    setModelQuery("");
    setRuntimeMenuView("runtime");
  }, []);

  // Current Runtime / Model / Reasoning values + options for the @ palette.
  const runtimeValue = sessionExecutorSelection?.executor ?? null;
  const runtimeLabel = runtimeValue
    ? executorLabels[runtimeValue] ?? runtimeValue
    : null;
  const runtimeOptions = useMemo(
    () =>
      availableExecutors.map((executor) => ({
        value: executor,
        label: executorLabels[executor] ?? executor.replace(/_/g, " "),
      })),
    [availableExecutors, executorLabels],
  );
  const modelValue = sessionExecutorSelection?.model ?? null;
  // pi's model list is provider-dependent, so it is fetched from the agent
  // (narrowed to the user's configured providers) rather than hardcoded.
  const [piModels, setPiModels] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    if (runtimeValue !== "PI") {
      return;
    }
    let cancelled = false;
    void fetchPiModels().then((models) => {
      if (!cancelled) {
        setPiModels(
          models.map((m) => ({
            value: m.value,
            label: m.label,
            description: m.provider,
          })),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [runtimeValue]);
  const modelOptions = useMemo(() => {
    if (!runtimeValue) return [];
    if (runtimeValue === "PI") return piModels ?? [];
    return getModelOptions(runtimeValue);
  }, [runtimeValue, piModels]);
  // Only surface the search box when the list is long enough to need it
  // (pi); Claude/Codex have a handful of presets where it would be noise.
  const showModelSearch = modelOptions.length > 8;
  const filteredModelOptions = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    if (!q) return modelOptions;
    return modelOptions.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.value.toLowerCase().includes(q) ||
        (m.description?.toLowerCase().includes(q) ?? false),
    );
  }, [modelOptions, modelQuery]);
  // Focus the search box when entering the model step so the user can type
  // immediately (the step is reached via in-place nav, not a fresh open).
  useEffect(() => {
    if (!runtimeMenuOpen || runtimeMenuView !== "model" || !showModelSearch) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      modelSearchRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [runtimeMenuOpen, runtimeMenuView, showModelSearch]);
  const modelLabel = useMemo(() => {
    if (!runtimeValue) return null;
    if (runtimeValue === "PI") {
      if (!modelValue) return RUNTIME_DEFAULT_LABEL;
      return piModels?.find((m) => m.value === modelValue)?.label ?? modelValue;
    }
    return getModelLabel(runtimeValue, modelValue) ?? RUNTIME_DEFAULT_LABEL;
  }, [runtimeValue, modelValue, piModels]);
  const reasoningValue = sessionExecutorSelection?.reasoning_effort ?? null;
  const reasoningLabel =
    getReasoningLabel(reasoningValue) ?? RUNTIME_DEFAULT_LABEL;
  const showReasoning = runtimeValue
    ? runtimeSupportsReasoning(runtimeValue)
    : false;

  const { submitPrompt } = useSingleSessionController({
    workspace,
    routeProjectId,
    activeTaskId: activeStreamTaskId,
    taskRunId,
    forceNewAttempt: shouldForceNewAttempt,
    useWorktree,
    baseBranch,
    sessionExecutorSelection,
    executorProfileId,
    t,
    editor,
    isSessionMountedRef,
    latestRouteProjectIdRef,
    latestRouteTaskSlugRef,
    abortRegistry,
    addErrorMessage,
    navigateToSession,
    createPerfRequestId,
  });

  // Load task handler (user clicks on a task in the sidebar)
  const handleLoadTask = useCallback(
    (task: StoredTask, selectedRunId?: string) => {
      if (task.id === sidebarActiveTaskId && !selectedRunId) {
        return;
      }
      handleFullReset();
      setForceNewAttempt(null);
      clearUploadItems();
      editor.clear();
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      navigateToSession(slugOrId(task), selectedRunId ?? null);
    },
    [
      handleFullReset,
      clearUploadItems,
      fileInputRef,
      navigateToSession,
      sidebarActiveTaskId,
    ],
  );

  const buildPromptPayload = useCallback((): PreparedPromptPayload | null => {
    const contextEntries = editor.getContextEntries();
    const contextPrefix = formatContextForPrompt(contextEntries);
    const skillEntries = editor.getSkillEntries();
    const skillPrefix = formatSkillContextForPrompt(skillEntries);
    const imagesMarkdown = getImagesMarkdown();
    const text = editor.getText().trim();
    const prompt = [contextPrefix, skillPrefix, imagesMarkdown, text]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!prompt) {
      return null;
    }
    return {
      prompt,
      contextRefs: contextEntriesToRefs(contextEntries),
      imageIds: getImageIds(),
      selectedSkillIds: skillEntries.map((skill) => skill.id),
    };
  }, [editor, getImageIds, getImagesMarkdown]);

  // Send handler
  const handleSend = useCallback(async () => {
    if (editor.isEmpty()) {
      return;
    }

    if (!workspace && !activeStreamTaskId) {
      addErrorMessage(t("workspaceNotSetError"));
      return;
    }

    if (isUploading) return;

    const payload = buildPromptPayload();
    if (!payload) {
      return;
    }

    if (isSending) {
      return;
    }

    const requestId = createPerfRequestId();
    const createdAt = new Date().toISOString();
    beginPendingSubmission({
      requestId,
      prompt: payload.prompt,
      createdAt,
      taskId: activeStreamTaskId,
      taskSlug: routeTaskSlug,
    });
    setScrollToBottomSignal((value) => value + 1);

    editor.clearWithSnapshot();
    clearUploadItems();
    const accepted = await submitPrompt(payload, {
      requestId,
      restoreOnError: true,
      onAccepted: (response) => {
        resolvePendingSubmission(requestId, response);
      },
    });

    if (!accepted) {
      clearPendingSubmission(requestId);
    }
  }, [
    activeStreamTaskId,
    beginPendingSubmission,
    clearPendingSubmission,
    createPerfRequestId,
    editor,
    workspace,
    addErrorMessage,
    t,
    isUploading,
    buildPromptPayload,
    isSending,
    clearUploadItems,
    setScrollToBottomSignal,
    submitPrompt,
    resolvePendingSubmission,
    routeTaskSlug,
  ]);

  // Retry a turn that ended without doing work (malformed tool call, server-side
  // API error, ...): continue the existing session ("auto") with a fixed nudge,
  // mirroring handleSend's optimistic pending-submission bookkeeping.
  const retryTurnWith = useCallback(
    (prompt: string) => {
      if (!activeTaskId || isSending) {
        return;
      }
      const requestId = createPerfRequestId();
      const createdAt = new Date().toISOString();
      beginPendingSubmission({
        requestId,
        prompt,
        createdAt,
        taskId: activeStreamTaskId,
        taskSlug: routeTaskSlug,
      });
      setScrollToBottomSignal((value) => value + 1);
      void submitPrompt(
        {
          prompt,
          contextRefs: [],
          imageIds: null,
          selectedSkillIds: [],
        },
        {
          requestId,
          mode: "auto",
          onAccepted: (response) => {
            resolvePendingSubmission(requestId, response);
          },
        },
      ).then((accepted) => {
        if (!accepted) {
          clearPendingSubmission(requestId);
        }
      });
    },
    [
      activeTaskId,
      isSending,
      createPerfRequestId,
      beginPendingSubmission,
      activeStreamTaskId,
      routeTaskSlug,
      setScrollToBottomSignal,
      submitPrompt,
      resolvePendingSubmission,
      clearPendingSubmission,
    ],
  );

  const handleRetryMalformedToolCall = useCallback(
    () => retryTurnWith(MALFORMED_TOOL_CALL_RETRY_PROMPT),
    [retryTurnWith],
  );

  const handleRetryApiError = useCallback(
    () => retryTurnWith(API_ERROR_RETRY_PROMPT),
    [retryTurnWith],
  );

  const conversationActions = useMemo(
    () => ({
      onRetryMalformedToolCall: handleRetryMalformedToolCall,
      onRetryApiError: handleRetryApiError,
    }),
    [handleRetryMalformedToolCall, handleRetryApiError],
  );

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
  const handleStreamFinished = useCallback(() => {
    if (pendingSubmission?.requestId) {
      finishPendingSubmission(
        pendingSubmission.requestId,
        new Date().toISOString(),
      );
    }
  }, [finishPendingSubmission, pendingSubmission?.requestId]);

  const {
    entries,
    isLoading: isConversationLoading,
    isLoadingMoreHistory,
    hasMoreHistory,
    isStreaming: isConversationStreaming,
    error: conversationError,
    approvals,
    loadMoreHistory,
  } = useConversationHistory({
    sessionScopeId: promptScopeId,
    taskId: activeStreamTaskId,
    enabled: Boolean(activeTaskId || pendingSubmission),
    runs: taskRuns,
    runsLoading: isTaskRunsLoading,
    runsError: taskRunsError,
    sessions: taskSessions,
    sessionsLoading: isTaskSessionsLoading,
    sessionsError: taskSessionsError,
    pendingSubmission,
    callbacks: {
      onFinished: handleStreamFinished,
    },
  });

  // Surface pending AskUserQuestion approvals from the active stream as the
  // interactive question panel, and drop the panel once the approval resolves
  // (answered, denied, or timed out).
  useEffect(() => {
    if (!taskRunId) return;

    const pendingApproval = Object.values(approvals).find(
      (approval) =>
        approval.task_run_id === taskRunId &&
        approval.tool_name === "AskUserQuestion" &&
        approval.status.status === "pending",
    );
    const questions = pendingApproval
      ? (pendingApproval.tool_input as { questions?: UserQuestion[] } | null)
          ?.questions ?? []
      : [];

    const store = useUserQuestionStore.getState();
    // An approval with a locally recorded result was already answered or
    // skipped — its stream record just hasn't flipped from "pending" yet.
    if (
      pendingApproval &&
      questions.length > 0 &&
      !store.results.has(pendingApproval.id)
    ) {
      const existing = store.pendingQuestions.get(taskRunId);
      if (existing?.toolUseId !== pendingApproval.id) {
        store.setPendingQuestions(taskRunId, {
          taskRunId,
          toolUseId: pendingApproval.id,
          questions,
        });
      }
    } else {
      store.clearPendingQuestions(taskRunId);
    }
  }, [approvals, taskRunId]);

  // Find-in-conversation (Cmd/Ctrl+F), mirroring the file editor's find UX.
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const sessionRootRef = useRef<HTMLDivElement | null>(null);
  const find = useConversationFind({
    enabled: Boolean(activeTaskId || pendingSubmission),
    scrollContainerRef: conversationScrollRef,
    rootRef: sessionRootRef,
    recomputeKey: entries.length,
    resetKey: activeTaskId,
  });

  // When the message-nav rail targets a turn that tail virtualization left
  // unmounted, mount the whole conversation so the scroll can land. Reset on
  // session switch so a fresh conversation starts virtualized again.
  const [conversationExpandAll, setConversationExpandAll] = useState(false);
  const ensureConversationMounted = useCallback(() => {
    setConversationExpandAll(true);
  }, []);
  useEffect(() => {
    setConversationExpandAll(false);
  }, [activeTaskId]);

  useEffect(() => {
    if (!pendingSubmission?.runId) {
      return;
    }
    const matchingRun = taskRuns.find(
      (run) => run.id === pendingSubmission.runId,
    );
    if (
      matchingRun &&
      matchingRun.status !== "running" &&
      matchingRun.status !== "pending"
    ) {
      finishPendingSubmission(
        pendingSubmission.requestId,
        matchingRun.completed_at ??
          matchingRun.updated_at ??
          new Date().toISOString(),
      );
    }
  }, [finishPendingSubmission, pendingSubmission, taskRuns]);

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
    setEnvironmentPopoverOpen(false);
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

  // Fetch branches when the environment popover opens (powers the rebase form)
  useEffect(() => {
    if (!environmentPopoverOpen || !taskRunId) {
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
  }, [environmentPopoverOpen, taskRunId]);

  const handleRebaseConfirm = useCallback(
    (result: RebaseConfirmResult) => {
      void rebase(result.targetBranch, result.upstreamBranch);
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

  const handleOpenInEditor = useCallback(async () => {
    if (!workspace) {
      toast({
        variant: "destructive",
        title: "Cannot open project",
        description: "Workspace path is not available.",
      });
      return;
    }

    const option = getSelectedOpenInOption();
    if (!option) {
      toast({
        variant: "destructive",
        title: "Cannot open project",
        description: "No Open in app is available.",
      });
      return;
    }

    try {
      await openWorkspaceWithOption(workspace, option);
    } catch (error) {
      console.warn("[session] Failed to open conflict workspace", {
        app: option.label,
        with: option.with,
        workspacePath: workspace,
        error,
      });
      toast({
        title: `Could not open in ${option.label}`,
        description: getOpenInErrorDescription(option.label, error),
      });
    }
  }, [workspace]);

  const handleTitleChange = useCallback(
    async (newTitle: string) => {
      if (!activeStreamTaskId) return;
      const task = await updateTaskTitle(activeStreamTaskId, newTitle);
      useTaskTitleOverridesStore.getState().setTaskTitleOverride(task);
    },
    [activeStreamTaskId],
  );

  // Input handlers (keyDown, composition moved to PromptEditor / usePromptEditor)
  const fileDrag = useComposerFileDrag();

  const handleDropFiles = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      fileDrag.endDrag();

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
        editor.addSessionPart(sessionPayload.taskId, sessionPayload.branch);
        return;
      }

      const files = extractFilesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      handleFiles(files);
    },
    [workspace, editor, addErrorMessage, t, handleFiles, fileDrag.endDrag],
  );

  const handlePasteFiles = useCallback(
    (event: ReactClipboardEvent<HTMLElement>) => {
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

  // Focus prompt editor when task/run session route changes
  useEffect(() => {
    // Small delay to ensure DOM is ready after session switch
    const timeoutId = setTimeout(() => {
      editor.focus();
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [activeTaskId, routeRunSlug, editor]);

  // Note: activeTask, isSending, canSend are defined earlier for use in callbacks
  const activeTaskBranch = activeTask?.branch?.trim() || null;
  const activeTaskTitle = useMemo(() => {
    const title = activeTask?.title?.trim();
    return title && title.length > 0 ? title : null;
  }, [activeTask]);
  // isSendButtonDisabled is now computed inside PromptInputArea via store subscription
  const executorSelectorLabel = executorProfileLoading
    ? t("loadingMessage")
    : executorDisplayLabel;
  // Model shown alongside the runtime on the selector button; hidden while the
  // executor profile is still loading.
  const executorModelLabel = executorProfileLoading ? null : modelLabel;

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
  const diffAdditions = useMemo(
    () => diffItems.reduce((sum, item) => sum + (item.entry.additions ?? 0), 0),
    [diffItems],
  );
  const diffDeletions = useMemo(
    () => diffItems.reduce((sum, item) => sum + (item.entry.deletions ?? 0), 0),
    [diffItems],
  );
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

  // Rebase only needs the branch to be behind its base; local changes are not
  // required so the worktree can be brought up to date even with no diffs.
  const canRebase = Boolean(
    taskRunId &&
      branchStatus?.target_branch &&
      !isRebasing &&
      commitsBehind > 0,
  );

  // Filter out archived tasks (now using status field)
  const sortedTasks = useMemo(() => {
    const visibleTasks = displayedTasks.filter((task) => !isArchived(task));
    return visibleTasks.sort((a, b) => {
      const orderDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0);
      if (orderDiff !== 0) return orderDiff;
      return (
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    });
  }, [displayedTasks, isArchived]);

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

  // A not-yet-started session: surface the "From" branch and Worktree/Local
  // pickers beneath the prompt so they're chosen before the run begins. Once a
  // run exists these move into the header environment popover, so the inline
  // footer hides itself. Scratch and non-Git projects have no worktree/branch
  // choice to make, so it stays hidden there too.
  const showNewSessionExecutionControls =
    !isScratch && !activeTaskId && !pendingSubmission && isGitRepository;

  // Render helpers
  const renderPromptContent = (
    containerClassName: string,
    inputWrapperClassName: string,
  ) => (
    <div
      className={containerClassName}
      onDrop={handleDropFiles}
      onDragOver={fileDrag.onDragOver}
      onDragLeave={fileDrag.onDragLeave}
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

      {/* Wrapper doubles as the stacking context so the new-session tray can
          tuck behind the card (card z-10 over tray z-0). */}
      <div
        className={cn("relative w-full px-4 pb-4 pt-3", inputWrapperClassName)}
      >
        <div
          className={cn(
            "relative z-10 flex flex-col gap-3 rounded-2xl border bg-background p-4 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:shadow-md",
            fileDrag.isDragActive
              ? "border-primary ring-2 ring-primary/20"
              : "border-custom-border-200",
          )}
        >
          {isWorktreeCleanedUp ? (
            <div
              role="status"
              className="-mt-1 flex items-center gap-2 rounded-lg bg-custom-background-90 px-3 py-2 text-xs text-custom-text-300"
            >
              <CircleSlash className="size-3.5 shrink-0" />
              <span>{t("sessionWorktreeCleanedNotice")}</span>
            </div>
          ) : null}
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
            tasks={sortedTasks}
            atActiveIndex={atActiveIndex}
            onActiveIndexChange={setAtActiveIndex}
            disabled={
              (!workspace && !activeStreamTaskId) || isWorktreeCleanedUp
            }
            dropActive={fileDrag.isDragActive}
            onSubmit={handleSend}
            onDrop={handleDropFiles}
            onPaste={handlePasteFiles}
            t={t}
            runtimeValue={runtimeValue}
            runtimeLabel={runtimeLabel}
            runtimeOptions={runtimeOptions}
            onSelectRuntime={handleExecutorSelect}
            modelValue={modelValue}
            modelLabel={modelLabel}
            modelOptions={modelOptions}
            onSelectModel={handleModelSelect}
            reasoningValue={reasoningValue}
            reasoningLabel={reasoningLabel}
            reasoningOptions={REASONING_OPTIONS}
            onSelectReasoning={handleReasoningSelect}
            showReasoning={showReasoning}
            runtimeLocked={isExecutorLocked}
            modelLocked={isModelLocked}
          />

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger
                        type="button"
                        aria-label={t("addContextButtonAria")}
                        disabled={isStopping}
                        className={cn(
                          buttonVariants({ variant: "ghost", size: "icon" }),
                          "flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground transition hover:!bg-muted hover:!text-foreground",
                          "disabled:cursor-not-allowed disabled:opacity-40",
                        )}
                      >
                        <Plus className="h-4 w-4" />
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-[11px]">
                      {t("addContextButtonAria")}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuItem
                    onSelect={handleSelectFiles}
                    className="gap-2.5 text-[13px]"
                  >
                    <ImageIcon className="h-4 w-4 text-muted-foreground" />
                    <span>{t("addPhotosLabel")}</span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => openContextCategory("skills")}
                    className="gap-2.5 text-[13px]"
                  >
                    <BookOpen className="h-4 w-4 text-muted-foreground" />
                    <span>Skills</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openContextCategory("files")}
                    className="gap-2.5 text-[13px]"
                  >
                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    <span>Files &amp; Folders</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => openContextCategory("sessions")}
                    className="gap-2.5 text-[13px]"
                  >
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                    <span>Sessions</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <div className="mx-1 h-4 w-px bg-border" />

              <DropdownMenu
                open={runtimeMenuOpen}
                onOpenChange={handleRuntimeMenuOpenChange}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={
                      executorProfileLoading ||
                      availableExecutors.length === 0 ||
                      (isExecutorLocked && isModelLocked)
                    }
                    className={cn(
                      "flex h-9 items-center justify-center gap-1.5 rounded-[4px] px-2 text-xs font-medium text-muted-foreground transition hover:bg-muted/40 hover:text-primary",
                      isExecutorLocked && isModelLocked ? "bg-muted/40" : "",
                      "disabled:cursor-not-allowed disabled:opacity-40",
                    )}
                  >
                    <AgentLogo
                      agent={sessionExecutorSelection?.executor ?? null}
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="text-xs">{executorSelectorLabel}</span>
                    {executorModelLabel ? (
                      <>
                        <span className="text-xs text-muted-foreground/30">
                          ·
                        </span>
                        <span className="text-xs text-muted-foreground/70">
                          {executorModelLabel}
                        </span>
                      </>
                    ) : null}
                    <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[200px]">
                  {/* Step 1 — pick a runtime. Runtime can't change mid-session,
                      so once locked we skip straight to the model step. */}
                  {runtimeMenuView === "runtime" && !isExecutorLocked ? (
                    <>
                      <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        Runtime
                      </DropdownMenuLabel>
                      {availableExecutors.map((executor) => {
                        const isActive =
                          sessionExecutorSelection?.executor === executor;
                        return (
                          <DropdownMenuItem
                            key={executor}
                            // Stay open and advance to the model step instead of
                            // committing-and-closing on the first click.
                            onSelect={(event) => {
                              event.preventDefault();
                              handleRuntimePick(executor);
                            }}
                            className="flex items-center justify-between gap-3 text-[11px]"
                          >
                            <span className="flex items-center gap-2">
                              <AgentLogo
                                agent={executor}
                                className="h-3.5 w-3.5 shrink-0"
                              />
                              {executorLabels[executor] ??
                                executor.replace(/_/g, " ")}
                            </span>
                            <span className="flex items-center gap-1.5">
                              {isActive ? (
                                <Check className="h-3.5 w-3.5" />
                              ) : null}
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                            </span>
                          </DropdownMenuItem>
                        );
                      })}
                    </>
                  ) : (
                    <>
                      {/* Step 2 — pick a model for the chosen runtime. */}
                      {!isExecutorLocked ? (
                        <DropdownMenuItem
                          onSelect={(event) => {
                            event.preventDefault();
                            handleModelStepBack();
                          }}
                          className="flex items-center gap-2 text-[11px] text-muted-foreground"
                        >
                          <ChevronLeft className="h-3.5 w-3.5" />
                          <AgentLogo
                            agent={sessionExecutorSelection?.executor ?? null}
                            className="h-3.5 w-3.5 shrink-0"
                          />
                          <span>{runtimeLabel ?? "Runtime"}</span>
                        </DropdownMenuItem>
                      ) : null}
                      {!isExecutorLocked ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                        Model
                      </DropdownMenuLabel>
                      {showModelSearch ? (
                        <div className="px-2 pb-1">
                          <div className="relative">
                            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <input
                              ref={modelSearchRef}
                              type="text"
                              placeholder={t("modelSelectorSearchPlaceholder")}
                              value={modelQuery}
                              onChange={(event) =>
                                setModelQuery(event.target.value)
                              }
                              // Radix menus run a typeahead on keystrokes; stop
                              // propagation so the search box keeps the keys.
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  setRuntimeMenuOpen(false);
                                  return;
                                }
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  const first = filteredModelOptions[0];
                                  if (first) {
                                    handleModelSelect(first.value);
                                    setRuntimeMenuOpen(false);
                                  }
                                  return;
                                }
                                event.stopPropagation();
                              }}
                              className="w-full rounded-sm border border-border bg-background py-1.5 pl-7 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                            />
                          </div>
                        </div>
                      ) : null}
                      {modelOptions.length === 0 ? (
                        <DropdownMenuItem
                          disabled
                          className="text-[11px] text-muted-foreground"
                        >
                          {runtimeValue === "PI" && piModels === null
                            ? t("loadingMessage")
                            : RUNTIME_DEFAULT_LABEL}
                        </DropdownMenuItem>
                      ) : filteredModelOptions.length === 0 ? (
                        <div className="px-2 py-2 text-center text-[11px] text-muted-foreground">
                          {t("modelSelectorEmpty")}
                        </div>
                      ) : (
                        <div className="max-h-[40vh] overflow-y-auto">
                          {filteredModelOptions.map((model) => {
                            const isActive = modelValue === model.value;
                            return (
                              <DropdownMenuItem
                                key={model.value}
                                onClick={() => handleModelSelect(model.value)}
                                className="flex items-center justify-between gap-3 text-[11px]"
                              >
                                <span>{model.label}</span>
                                {isActive ? (
                                  <Check className="h-3.5 w-3.5" />
                                ) : null}
                              </DropdownMenuItem>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

              {referencesPopoverEnabled ? (
                <SessionReferencesPopover
                  taskId={sidebarActiveTaskId}
                  tasksById={tasksById}
                  side="top"
                  align="start"
                  onOpenTask={(taskIdOrSlug) =>
                    navigateToSession(taskIdOrSlug, null)
                  }
                  onOpenFile={(path) =>
                    openFilePath(path, taskRunId ?? undefined)
                  }
                />
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <SendButtonWithState
                editorHandle={editor}
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

        {/* Tray tucked behind the card bottom: From-branch + Worktree/Local
            pickers for a not-yet-started session. */}
        {showNewSessionExecutionControls && (
          <NewSessionExecutionControls
            className="relative z-0 mx-0.5 -mt-4 h-[58px] rounded-b-2xl bg-muted/60 px-2 pt-4"
            useWorktree={useWorktree}
            onUseWorktreeChange={setUseWorktree}
            baseBranch={baseBranch}
            baseBranchSearch={baseBranchSearch}
            onBaseBranchSearchChange={setBaseBranchSearch}
            filteredBaseBranches={filteredBaseBranches}
            onBaseBranchSelect={setBaseBranch}
          />
        )}
      </div>
    </div>
  );

  const renderGlobalPrompt = () => (
    <div className="bg-background/80 backdrop-blur">
      {!isScratch && (hasConflicts || isRebaseInProgress) && (
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
          <AgentUserQuestion
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
    "text-[12px] inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40";
  const conversationScrollKey =
    activeTaskId ?? pendingSubmission?.tempTaskId ?? "session";

  // This ensures follow-up messages (which create new TaskRuns) are visible
  const conversationContent = (
    <div
      className={cn("flex h-full max-w-full flex-col gap-4 min-h-0", "mx-auto")}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTaskId || pendingSubmission ? (
          <ConversationActionsContext.Provider value={conversationActions}>
            <TaskConversation
              key={conversationScrollKey}
              entries={entries}
              isLoading={isConversationLoading}
              error={conversationError}
              messagesEndRef={messagesEndRef}
              scrollContainerRef={conversationScrollRef}
              searchActive={find.searchActive}
              expandAll={conversationExpandAll}
              scrollCacheKey={conversationScrollKey}
              isStreaming={isConversationStreaming}
              scrollToBottomSignal={scrollToBottomSignal}
              hasMoreHistory={hasMoreHistory}
              isLoadingMoreHistory={isLoadingMoreHistory}
              onLoadMoreHistory={loadMoreHistory}
              onWikilinkClick={navigateToWikilink}
              onFilePathClick={(path) =>
                openFilePath(path, taskRunId ?? undefined)
              }
            />
          </ConversationActionsContext.Provider>
        ) : (
          <ProjectOverview />
        )}
      </div>
    </div>
  );

  return (
    <>
      <div className="flex h-full w-full justify-end bg-muted text-foreground">
        <div className="flex h-full w-full max-w-full bg-background">
          {/* The session list previously lived here as a ResizableSidebar.
              It now lives in the LeftDock's Sessions panel and is hidden
              from the tab body to avoid a double-sidebar. */}
          <div
            ref={sessionRootRef}
            className="flex min-w-0 flex-1 flex-col bg-background"
          >
            <SessionHeader
              taskTitle={activeTaskTitle}
              environmentControl={
                isScratch ? undefined : (
                  <EnvironmentPopover
                    taskId={sidebarActiveTaskId}
                    taskBranch={activeTaskBranch}
                    runTargetBranch={
                      branchStatus?.target_branch ??
                      currentTaskRunTargetBranch ??
                      null
                    }
                    isGitRepository={isGitRepository}
                    isExecutorLocked={isExecutorLocked}
                    additions={diffAdditions}
                    deletions={diffDeletions}
                    hasDiffs={hasDiffs}
                    useWorktree={useWorktree}
                    onUseWorktreeChange={setUseWorktree}
                    baseBranch={baseBranch}
                    baseBranchSearch={baseBranchSearch}
                    onBaseBranchSearchChange={setBaseBranchSearch}
                    filteredBaseBranches={filteredBaseBranches}
                    onBaseBranchSelect={setBaseBranch}
                    canRebase={canRebase}
                    isRebasing={isRebasing}
                    commitsBehind={commitsBehind}
                    branches={branches}
                    isLoadingBranches={isLoadingBranches}
                    initialTargetBranch={
                      currentTaskRunTargetBranch ?? undefined
                    }
                    initialUpstreamBranch={
                      currentTaskRunTargetBranch ?? undefined
                    }
                    onRebaseConfirm={handleRebaseConfirm}
                    canMergeDiffs={canMergeDiffs}
                    isMergingDiffs={isMergingDiffs}
                    onMergeDiffs={handleMergeDiffs}
                    isInitializingGit={isInitializingGit}
                    canInitGit={Boolean(routeProjectId)}
                    onInitGitRepo={handleInitGitRepo}
                    onOpenChange={setEnvironmentPopoverOpen}
                  />
                )
              }
              onTitleChange={activeStreamTaskId ? handleTitleChange : undefined}
              isSidebarCollapsed={sessionSidebarCollapsed}
              onOpenSidebar={() => toggleSessionSidebarCollapsed(false)}
              t={t}
            />
            <main className="flex-1 overflow-hidden">
              <div className="flex h-full flex-col overflow-hidden">
                <div className="relative flex-1 overflow-hidden">
                  {conversationContent}
                  <ConversationFindBar controller={find} />
                  {(activeTaskId || pendingSubmission) && (
                    <ConversationMessageNav
                      entries={entries}
                      scrollContainerRef={conversationScrollRef}
                      onEnsureAllMounted={ensureConversationMounted}
                      resetKey={conversationScrollKey}
                    />
                  )}
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
