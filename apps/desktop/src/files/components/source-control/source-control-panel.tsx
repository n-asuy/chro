import { useBranchStatus } from "@/hooks/use-branch-status";
import { useMergeRun } from "@/hooks/use-merge-run";
import { useRebase } from "@/hooks/use-rebase";
import { type TranslationKey, useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  type FileChangeStatus,
  type GitScope,
} from "@/lib/git-client";
import { resolveGitError } from "@/lib/git-error";
import type { DiffChangeKind } from "@/session/hooks";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";
import { toast } from "@chro/ui/hooks/use-toast";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  FileDiff,
  FileEdit,
  FilePlus,
  FileX,
  GitBranch,
  List,
  ListTree,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useProjectContext } from "../../context/project-context";
import {
  ChangeFileList,
  type ChangeFileEntry,
  type ChangeListViewMode,
} from "./change-file-list";
import { useActiveWorkspaceScope } from "../../hooks/use-active-workspace-scope";
import { useGitStatus } from "../../hooks/use-git-status";
import { useFilesStore } from "../../state/files-store";
import { useWorkingDiffs } from "../../state/working-diffs-store";

const formatDate = (date: Date): string => {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const getDefaultCommitMessage = (): string => {
  return `backup: ${formatDate(new Date())}`;
};

const getStatusIcon = (status: FileChangeStatus) => {
  switch (status) {
    case "added":
      return <FilePlus className="size-4 text-green-500" />;
    case "deleted":
      return <FileX className="size-4 text-red-500" />;
    case "modified":
      return <FileEdit className="size-4 text-yellow-500" />;
    case "renamed":
      return <File className="size-4 text-blue-500" />;
    default:
      return <File className="size-4 text-custom-text-300" />;
  }
};

/** Source Control scope: all branch changes (vs a base) or just uncommitted. */
type SourceControlScope = "all" | "uncommitted";

/** Default base ref to compare a branch against in "all" scope. */
const DEFAULT_BASE_REF = "main";

/** Persist the flat/tree preference so it survives reloads (VSCode-style). */
const FILE_VIEW_MODE_KEY = "chro.sourceControl.fileViewMode";

const readFileViewMode = (): ChangeListViewMode =>
  typeof window !== "undefined" &&
  window.localStorage.getItem(FILE_VIEW_MODE_KEY) === "tree"
    ? "tree"
    : "list";

const changeKindToStatus = (change: DiffChangeKind): FileChangeStatus =>
  change === "permission_change" ? "typechange" : change;

const getStatusLabel = (status: FileChangeStatus): string => {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "modified":
      return "M";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typechange":
      return "T";
    default:
      return "?";
  }
};

interface FileItemProps {
  path: string;
  status?: FileChangeStatus;
  isUntracked?: boolean;
  additions?: number;
  deletions?: number;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  onOpenFile?: () => void;
  onOpenDiff?: () => void;
  isStaged?: boolean;
  /** Nesting depth in tree view; 0 keeps the flat-list indentation. */
  indent?: number;
}

const FileItem = ({
  path,
  status,
  isUntracked,
  additions,
  deletions,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
  onOpenDiff,
  isStaged,
  indent = 0,
}: FileItemProps) => {
  // Display only the terminal path segment.
  // Handles edge cases: empty path, directory paths ending with "/"
  const fileName = (() => {
    if (!path || path.trim().length === 0) return "(unknown)";
    if (path.endsWith("/")) return path;
    return path.split("/").pop() || path || "(unknown)";
  })();

  return (
    <div
      className="group flex items-center gap-2 rounded pr-2 text-sm hover:bg-custom-background-80"
      title={path}
    >
      <button
        type="button"
        onClick={onOpenDiff}
        disabled={!onOpenDiff}
        className="flex min-w-0 flex-1 items-center gap-2 rounded py-1 text-left disabled:cursor-default"
        style={{ paddingLeft: 8 + indent * 12 }}
      >
        <span className="flex-shrink-0">
          {isUntracked ? (
            <FilePlus className="size-4 text-green-500" />
          ) : status ? (
            getStatusIcon(status)
          ) : (
            <File className="size-4 text-custom-text-300" />
          )}
        </span>
        <span className="block min-w-0 flex-1 truncate text-custom-text-100">
          {fileName}
        </span>
      </button>
      <div className="flex flex-shrink-0 items-center gap-1">
        {(additions ?? 0) > 0 && (
          <span className="text-[11px] font-medium tabular-nums text-emerald-500 dark:text-emerald-400">
            +{additions}
          </span>
        )}
        {(deletions ?? 0) > 0 && (
          <span className="text-[11px] font-medium tabular-nums text-rose-500 dark:text-rose-400">
            -{deletions}
          </span>
        )}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
          {onOpenFile && (
            <button
              type="button"
              onClick={onOpenFile}
              className="rounded p-1 hover:bg-custom-background-90"
              title="Open file"
            >
              <ExternalLink className="size-3.5" />
            </button>
          )}
          {!isStaged && onDiscard && (
            <button
              type="button"
              onClick={onDiscard}
              className="rounded p-1 hover:bg-custom-background-90"
              title="Discard changes"
            >
              <Undo2 className="size-3.5" />
            </button>
          )}
          {!isStaged && onStage && (
            <button
              type="button"
              onClick={onStage}
              className="rounded p-1 hover:bg-custom-background-90"
              title="Stage file"
            >
              <Plus className="size-3.5" />
            </button>
          )}
          {isStaged && onUnstage && (
            <button
              type="button"
              onClick={onUnstage}
              className="rounded p-1 hover:bg-custom-background-90"
              title="Unstage file"
            >
              <Minus className="size-3.5" />
            </button>
          )}
        </div>
        {status && !isUntracked && (
          <span
            className={cn(
              "w-4 text-center text-xs font-medium",
              status === "added" && "text-green-500",
              status === "deleted" && "text-red-500",
              status === "modified" && "text-yellow-500",
              status === "renamed" && "text-blue-500",
            )}
          >
            {getStatusLabel(status)}
          </span>
        )}
        {isUntracked && (
          <span className="w-4 text-center text-xs font-medium text-green-500">
            U
          </span>
        )}
      </div>
    </div>
  );
};

interface CollapsibleSectionProps {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  actions?: React.ReactNode;
}

const CollapsibleSection = ({
  title,
  count,
  children,
  defaultExpanded = true,
  actions,
}: CollapsibleSectionProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div className="mb-2">
      <div className="flex w-full items-center gap-1 rounded px-2 py-1 text-xs font-medium text-custom-text-200 hover:bg-custom-background-80">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-1"
        >
          {expanded ? (
            <ChevronDown className="size-3.5" />
          ) : (
            <ChevronRight className="size-3.5" />
          )}
          <span className="flex-1 text-left">
            {title} ({count})
          </span>
        </button>
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {expanded && <div className="mt-1">{children}</div>}
    </div>
  );
};

export const SourceControlPanel = () => {
  const { t } = useLanguage();
  const { projectId } = useProjectContext();
  // When a session worktree is in view, Source Control reflects that run's
  // branch (per-branch changes); otherwise the project checkout.
  const { taskRunId: scopeTaskRunId } = useActiveWorkspaceScope();
  const gitScope = useMemo<GitScope | null>(
    () =>
      scopeTaskRunId
        ? { taskRunId: scopeTaskRunId }
        : projectId
          ? { projectId }
          : null,
    [scopeTaskRunId, projectId],
  );

  const {
    status,
    currentBranch,
    commitsAhead,
    commitsBehind,
    isLoading,
    refresh,
    stage,
    unstage,
    commit,
    push,
    pull,
    discard,
    discardFiles,
  } = useGitStatus({ projectId, taskRunId: scopeTaskRunId });

  const openFileInEditor = useFilesStore((state) => state.openFile);
  const requestDiffReveal = useFilesStore((state) => state.requestDiffReveal);
  const clearDiffReveal = useFilesStore((state) => state.clearDiffReveal);
  const openTab = useLayoutStore((state) => state.openTab);

  // Scope: "all" = every change this branch introduced vs a base
  // ref; "uncommitted" = working-tree changes only. Default to "all" in a
  // session worktree (review what the agent did), "uncommitted" on the project.
  const [scope, setScope] = useState<SourceControlScope>(
    scopeTaskRunId ? "all" : "uncommitted",
  );

  // In "all" scope a session branch is compared against its own target branch —
  // the ref it forked from and merges back into. That base is not selectable
  // here: letting this panel redefine the comparison is what made its numbers
  // disagree with the run's canonical diff shown in the header and the diff tab.
  const { status: branchStatus, refetch: refetchBranchStatus } =
    useBranchStatus({
      taskRunId: scopeTaskRunId,
      enabled: Boolean(scopeTaskRunId),
    });
  const runTargetBranch = branchStatus?.target_branch ?? null;
  const baseRef = scopeTaskRunId ? runTargetBranch : DEFAULT_BASE_REF;

  useEffect(() => {
    setScope(scopeTaskRunId ? "all" : "uncommitted");
  }, [scopeTaskRunId]);

  // Until the run's target branch is known, no base is correct: fetching with a
  // guessed one would render a number that silently disagrees with the run's
  // diff. Hold the request instead of showing a wrong total.
  const isBaseResolving = scope === "all" && Boolean(scopeTaskRunId) && !baseRef;
  const activeBase = scope === "all" ? (baseRef ?? undefined) : undefined;
  const { diffs: scopedDiffs } = useWorkingDiffs(
    isBaseResolving ? null : gitScope,
    activeBase,
  );

  // path → line counts, for the +/- badges on each changed row (uncommitted).
  const countsByPath = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>();
    for (const entry of scopedDiffs) {
      map.set(entry.path, {
        additions: entry.diff.additions ?? 0,
        deletions: entry.diff.deletions ?? 0,
      });
    }
    return map;
  }, [scopedDiffs]);

  const [fileViewMode, setFileViewMode] =
    useState<ChangeListViewMode>(readFileViewMode);
  const toggleFileViewMode = useCallback(() => {
    setFileViewMode((prev) => {
      const next = prev === "tree" ? "list" : "tree";
      if (typeof window !== "undefined") {
        window.localStorage.setItem(FILE_VIEW_MODE_KEY, next);
      }
      return next;
    });
  }, []);

  const [commitMessage, setCommitMessage] = useState(getDefaultCommitMessage);
  const [isCommitting, setIsCommitting] = useState(false);

  // A failed integration is otherwise invisible: the button simply stops
  // spinning. Report it the way the other git verbs in this panel do, and
  // refresh branch status because the failure usually leaves the worktree in a
  // new state (conflicts, a half-applied rebase) that the buttons key off.
  const reportIntegrationFailure = useCallback(
    (error: Error, fallbackKey: TranslationKey) => {
      toast({
        title: resolveGitError(error, t, fallbackKey),
        variant: "warning",
      });
      void refetchBranchStatus();
    },
    [refetchBranchStatus, t],
  );
  const handleRebaseError = useCallback(
    (error: Error) => reportIntegrationFailure(error, "rebaseErrorMessage"),
    [reportIntegrationFailure],
  );
  const handleMergeError = useCallback(
    (error: Error) => reportIntegrationFailure(error, "diffMergeErrorMessage"),
    [reportIntegrationFailure],
  );

  // Integration verbs. Both refresh branch status on success so the ahead/behind
  // counts these buttons key off reflect the new reality immediately.
  const { rebase, isRebasing } = useRebase({
    taskRunId: scopeTaskRunId,
    onSuccess: () => void refetchBranchStatus(),
    onError: handleRebaseError,
  });
  const { merge, isMerging, didMerge } = useMergeRun({
    taskRunId: scopeTaskRunId,
    onSuccess: () => void refetchBranchStatus(),
    onError: handleMergeError,
  });

  const conflictCount = branchStatus?.conflicted_files?.length ?? 0;
  // Any half-finished history rewrite makes integration unsafe; surface that
  // instead of offering buttons that would fail.
  const isRebaseBlocked =
    conflictCount > 0 || Boolean(branchStatus?.is_rebase_in_progress);
  // Integration compares against the run's TARGET branch, not the upstream:
  // `commitsAhead`/`commitsBehind` above drive Push/Pull (vs origin) and are
  // routinely 0 while the branch still diverges from its target.
  const targetAhead = branchStatus?.commits_ahead ?? 0;
  const targetBehind = branchStatus?.commits_behind ?? 0;
  // Rebase only needs the branch to be behind; merge needs something to land.
  const canRebase =
    Boolean(baseRef) && !isRebaseBlocked && !isRebasing && targetBehind > 0;
  const canMerge =
    Boolean(baseRef) && !isRebaseBlocked && !isMerging && targetAhead > 0;

  // The buttons stay visible even when unavailable, so each one has to say why
  // it is inert rather than leaving the user guessing.
  const baseLabel = baseRef ?? "base";
  const rebaseHint = isRebaseBlocked
    ? "Resolve the in-progress rebase first"
    : !baseRef
      ? "Waiting for the run's target branch"
      : targetBehind === 0
        ? `Already up to date with ${baseLabel}`
        : `Replay this branch on top of ${baseLabel}`;
  const mergeHint = isRebaseBlocked
    ? "Resolve the in-progress rebase first"
    : !baseRef
      ? "Waiting for the run's target branch"
      : targetAhead === 0
        ? "No commits to merge yet"
        : `Merge this branch into ${baseLabel}`;

  const handleRebase = useCallback(() => {
    if (!baseRef) return;
    void rebase(baseRef, baseRef);
  }, [baseRef, rebase]);

  // Update commit message with fresh timestamp when text area is focused
  const handleCommitMessageFocus = useCallback(() => {
    // Only update if still using default pattern
    if (commitMessage.startsWith("backup:")) {
      setCommitMessage(getDefaultCommitMessage());
    }
  }, [commitMessage]);

  const handleStageFile = useCallback(
    async (path: string) => {
      try {
        await stage([path]);
      } catch {}
    },
    [stage],
  );

  const handleUnstageFile = useCallback(
    async (path: string) => {
      try {
        await unstage([path]);
      } catch {}
    },
    [unstage],
  );

  const handleStageAll = useCallback(async () => {
    if (!status) return;
    const allPaths = [
      ...status.modified.map((f) => f.path),
      ...status.untracked,
    ];
    if (allPaths.length > 0) {
      try {
        await stage(allPaths);
      } catch {}
    }
  }, [status, stage]);

  const handleUnstageAll = useCallback(async () => {
    if (!status) return;
    const allPaths = status.staged.map((f) => f.path);
    if (allPaths.length > 0) {
      try {
        await unstage(allPaths);
      } catch {}
    }
  }, [status, unstage]);

  const handleDiscardFile = useCallback(
    async (path: string) => {
      try {
        await discardFiles([path]);
      } catch {}
    },
    [discardFiles],
  );

  const handleDiscardAll = useCallback(async () => {
    try {
      await discard();
    } catch {}
  }, [discard]);

  const handleOpenFile = useCallback(
    (path: string) => {
      // Normalize path to vault path format (leading slash)
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      // Pass the run scope explicitly so the file reads from the session
      // worktree even though this panel does not publish the store scope.
      openFileInEditor(normalizedPath, scopeTaskRunId ?? undefined);
    },
    [openFileInEditor, scopeTaskRunId],
  );

  // Open the combined changes diff (changed regions only, every file stacked).
  // In a session worktree this is the run's diff tab; otherwise the project's
  // working-changes tab. With a path, also ask that tab to scroll to the file:
  // this panel is the index, the diff tab is the content.
  const handleOpenDiff = useCallback(
    (path?: string) => {
      if (scopeTaskRunId) {
        openTab({ type: "diff", runId: scopeTaskRunId });
      } else if (projectId) {
        openTab({ type: "project-diff", projectId });
      } else {
        return;
      }
      if (path) requestDiffReveal(path, scopeTaskRunId ?? null);
      else clearDiffReveal();
    },
    [openTab, projectId, scopeTaskRunId, requestDiffReveal, clearDiffReveal],
  );

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim() || isCommitting) return;

    setIsCommitting(true);
    try {
      await commit(commitMessage);
      setCommitMessage(getDefaultCommitMessage());
    } catch {
    } finally {
      setIsCommitting(false);
    }
  }, [commitMessage, commit, isCommitting]);

  const handlePush = useCallback(async () => {
    try {
      await push();
    } catch {}
  }, [push]);

  const handlePull = useCallback(async () => {
    try {
      await pull();
    } catch {}
  }, [pull]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleCommit();
      }
    },
    [handleCommit],
  );

  const stagedCount = status?.staged.length ?? 0;
  const modifiedCount = status?.modified.length ?? 0;
  const untrackedCount = status?.untracked.length ?? 0;
  const changesCount = modifiedCount + untrackedCount;
  const canCommit = stagedCount > 0 && commitMessage.trim().length > 0;
  const pushCount = Math.max(0, commitsAhead);
  const pullCount = Math.max(0, commitsBehind);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      {/* Header with toolbar */}
      <div className="flex h-11 min-w-0 items-center justify-between gap-1 overflow-x-auto px-2">
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => handleOpenDiff()}
                  disabled={
                    isLoading ||
                    (scope === "all"
                      ? scopedDiffs.length === 0
                      : stagedCount + changesCount === 0)
                  }
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
                  aria-label="View All Changes"
                >
                  <FileDiff className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                View All Changes
              </TooltipContent>
            </Tooltip>
            {scope === "uncommitted" && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleCommit}
                      disabled={isLoading || isCommitting || !canCommit}
                      className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
                      aria-label="Commit"
                    >
                      <Check className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    Commit
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleStageAll}
                      disabled={isLoading || changesCount === 0}
                      className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
                      aria-label="Stage All"
                    >
                      <Plus className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    Stage All
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleUnstageAll}
                      disabled={isLoading || stagedCount === 0}
                      className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
                      aria-label="Unstage All"
                    >
                      <Minus className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    Unstage All
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handlePush}
                  disabled={isLoading}
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Push"
                >
                  <Upload className="size-4" />
                  <span className="ml-1 text-[10px] leading-none text-custom-text-300">
                    {pushCount}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                Push ({pushCount})
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handlePull}
                  disabled={isLoading}
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Pull"
                >
                  <Download className="size-4" />
                  <span className="ml-1 text-[10px] leading-none text-custom-text-300">
                    {pullCount}
                  </span>
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                Pull ({pullCount})
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={refresh}
                  disabled={isLoading}
                  className={cn(
                    "inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40",
                    isLoading && "animate-spin",
                  )}
                  aria-label="Refresh"
                >
                  <RefreshCw className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                Refresh
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleFileViewMode}
                className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100"
                aria-label={
                  fileViewMode === "tree" ? "View as List" : "View as Tree"
                }
                aria-pressed={fileViewMode === "tree"}
              >
                {fileViewMode === "tree" ? (
                  <ListTree className="size-4" />
                ) : (
                  <List className="size-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center">
              {fileViewMode === "tree" ? "View as List" : "View as Tree"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Scope toggle: all branch changes (vs base) ⇄ uncommitted only */}
      <div className="flex items-center gap-1 px-3 pt-1">
        <div className="flex rounded-[5px] bg-custom-background-80 p-0.5 text-xs">
          {(["all", "uncommitted"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              className={cn(
                "rounded-[4px] px-2 py-0.5 transition",
                scope === value
                  ? "bg-custom-background-100 text-custom-text-100 shadow-sm"
                  : "text-custom-text-300 hover:text-custom-text-100",
              )}
            >
              {value === "all" ? "All changes" : "Uncommitted"}
            </button>
          ))}
        </div>
      </div>

      {/* Branch / base row. Read-only: the comparison follows the run, so this
          states which branch is being compared against which base. */}
      <div className="px-3 py-2">
        <div className="flex w-full items-center gap-2 px-2 py-1 text-sm">
          <GitBranch className="size-3.5 shrink-0 text-custom-text-300" />
          <span className="truncate text-custom-text-200">
            {currentBranch ?? "No branch"}
          </span>
          {scope === "all" && baseRef && (
            <span className="shrink-0 text-custom-text-300">
              → <span className="text-custom-text-200">{baseRef}</span>
            </span>
          )}
        </div>
      </div>

      {/* Commit message input */}
      {scope === "uncommitted" && (
        <div className="bg-custom-background-80 px-3 py-2">
          <textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={handleCommitMessageFocus}
            placeholder="Commit message (Ctrl+Enter to commit)"
            className="w-full resize-none border-0 bg-transparent px-0 py-0 text-sm text-custom-text-100 placeholder:text-custom-text-300 focus:outline-none focus:ring-0"
            rows={2}
          />
        </div>
      )}

      {/* All-changes (branch vs base): read-only review list */}
      {scope === "all" && (
        <div className="flex-1 overflow-y-auto p-2">
          <CollapsibleSection title="Changes" count={scopedDiffs.length}>
            <ChangeFileList
              viewMode={fileViewMode}
              entries={scopedDiffs.map((entry) => ({
                path: entry.path,
                render: (depth) => (
                  <FileItem
                    key={entry.path}
                    indent={depth}
                    path={entry.path}
                    status={changeKindToStatus(entry.diff.change)}
                    additions={entry.diff.additions}
                    deletions={entry.diff.deletions}
                    onOpenFile={() => handleOpenFile(entry.path)}
                    onOpenDiff={() => handleOpenDiff(entry.path)}
                  />
                ),
              }))}
            />
            {scopedDiffs.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-custom-text-300">
                Up to date with {baseRef}
              </div>
            )}
          </CollapsibleSection>
        </div>
      )}

      {/* Uncommitted working-tree changes (staged / unstaged / untracked) */}
      {scope === "uncommitted" && (
        <div className="flex-1 overflow-y-auto p-2">
          {/* Staged changes */}
          <CollapsibleSection
            title="Staged Changes"
            count={stagedCount}
            actions={
              stagedCount > 0 && (
                <button
                  type="button"
                  onClick={handleUnstageAll}
                  className="rounded p-0.5 hover:bg-custom-background-90"
                  title="Unstage all"
                >
                  <Minus className="size-3.5" />
                </button>
              )
            }
          >
            <ChangeFileList
              viewMode={fileViewMode}
              entries={(status?.staged ?? []).map((file) => ({
                path: file.path,
                render: (depth) => (
                  <FileItem
                    key={file.path}
                    indent={depth}
                    path={file.path}
                    status={file.status}
                    additions={countsByPath.get(file.path)?.additions}
                    deletions={countsByPath.get(file.path)?.deletions}
                    isStaged
                    onUnstage={() => handleUnstageFile(file.path)}
                    onOpenFile={() => handleOpenFile(file.path)}
                    onOpenDiff={() => handleOpenDiff(file.path)}
                  />
                ),
              }))}
            />
          </CollapsibleSection>

          {/* Changes */}
          <CollapsibleSection
            title="Changes"
            count={changesCount}
            actions={
              changesCount > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleDiscardAll}
                    className="rounded p-0.5 hover:bg-custom-background-90"
                    title="Discard all"
                  >
                    <Undo2 className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleStageAll}
                    className="rounded p-0.5 hover:bg-custom-background-90"
                    title="Stage all"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </>
              )
            }
          >
            <ChangeFileList
              viewMode={fileViewMode}
              entries={[
                ...(status?.modified ?? []).map<ChangeFileEntry>((file) => ({
                  path: file.path,
                  render: (depth) => (
                    <FileItem
                      key={file.path}
                      indent={depth}
                      path={file.path}
                      status={file.status}
                      additions={countsByPath.get(file.path)?.additions}
                      deletions={countsByPath.get(file.path)?.deletions}
                      onStage={() => handleStageFile(file.path)}
                      onDiscard={() => handleDiscardFile(file.path)}
                      onOpenFile={() => handleOpenFile(file.path)}
                      onOpenDiff={() => handleOpenDiff(file.path)}
                    />
                  ),
                })),
                ...(status?.untracked ?? []).map<ChangeFileEntry>((path) => ({
                  path,
                  render: (depth) => (
                    <FileItem
                      key={path}
                      indent={depth}
                      path={path}
                      isUntracked
                      additions={countsByPath.get(path)?.additions}
                      deletions={countsByPath.get(path)?.deletions}
                      onStage={() => handleStageFile(path)}
                      onOpenFile={() => handleOpenFile(path)}
                      onOpenDiff={() => handleOpenDiff(path)}
                    />
                  ),
                })),
              ]}
            />
          </CollapsibleSection>
        </div>
      )}

      {/* Integrate: the verbs that land a run's work on its target. They belong
          here, next to the changes they act on, rather than in a header popover
          detached from the list. The section is always present in a worktree
          scope — a verb the user cannot find is a verb that does not exist — so
          state is carried by the label and the disabled reason, never by hiding
          the control. */}
      {scopeTaskRunId && (
        <div className="shrink-0 space-y-2 p-3 pt-0">
          {isRebaseBlocked && (
            <div className="rounded-md bg-amber-500/10 px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-700 dark:text-amber-400">
              {conflictCount > 0
                ? `Resolve ${conflictCount} conflicted ${conflictCount === 1 ? "file" : "files"} to continue`
                : "Finish the in-progress rebase to continue"}
            </div>
          )}

          <button
            type="button"
            onClick={handleRebase}
            disabled={!canRebase}
            title={rebaseHint}
            className="flex w-full items-center justify-between gap-2 rounded-md border border-custom-border-200 bg-custom-background-80 px-2.5 py-1.5 text-[12px] text-custom-text-100 shadow-sm transition hover:bg-custom-background-90 disabled:pointer-events-none disabled:opacity-40"
          >
            <span>
              {isRebasing ? "Rebasing…" : `Rebase onto ${baseLabel}`}
            </span>
            {targetBehind > 0 && (
              <span className="rounded bg-custom-background-80 px-1.5 py-0.5 text-[10px] tabular-nums text-custom-text-300">
                {targetBehind} behind
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => void merge()}
            disabled={!canMerge}
            title={mergeHint}
            className="flex w-full items-center justify-between gap-2 rounded-md bg-custom-primary-100 px-2.5 py-1.5 text-[12px] font-medium text-white transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          >
            <span>
              {isMerging
                ? "Merging…"
                : didMerge
                  ? "Merged"
                  : `Merge into ${baseLabel}`}
            </span>
            {targetAhead > 0 && (
              <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] tabular-nums">
                {targetAhead} ahead
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
