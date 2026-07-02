import { useBranchStatus } from "@/hooks/use-branch-status";
import { cn } from "@/lib/cn";
import {
  type BranchInfo,
  type FileChangeStatus,
  type GitScope,
  listGitBranches,
} from "@/lib/git-client";
import type { DiffChangeKind } from "@/session/hooks";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";
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
  Minus,
  Plus,
  RefreshCw,
  Search,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectContext } from "../../context/project-context";
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
        className="flex min-w-0 flex-1 items-center gap-2 rounded py-1 pl-2 text-left disabled:cursor-default"
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
  const openTab = useLayoutStore((state) => state.openTab);

  // Scope: "all" = every change this branch introduced vs a base
  // ref; "uncommitted" = working-tree changes only. Default to "all" in a
  // session worktree (review what the agent did), "uncommitted" on the project.
  const [scope, setScope] = useState<SourceControlScope>(
    scopeTaskRunId ? "all" : "uncommitted",
  );

  // The base ref a session branch is compared against in "all" scope. Defaults
  // to the run's actual target branch (what it forked from and merges back
  // into) rather than a hardcoded "main", so the comparison reflects reality
  // instead of always reading "vs main". The dropdown sets an explicit override;
  // `null` means "follow the run".
  const { status: branchStatus } = useBranchStatus({
    taskRunId: scopeTaskRunId,
    enabled: Boolean(scopeTaskRunId),
    pollInterval: 30000,
  });
  const [baseRefOverride, setBaseRefOverride] = useState<string | null>(null);
  const baseRef =
    baseRefOverride ?? branchStatus?.target_branch ?? DEFAULT_BASE_REF;

  useEffect(() => {
    setScope(scopeTaskRunId ? "all" : "uncommitted");
    // Drop any manual base-ref override so the newly scoped run's target branch
    // takes effect.
    setBaseRefOverride(null);
  }, [scopeTaskRunId]);

  const activeBase = scope === "all" ? baseRef : undefined;
  const { diffs: scopedDiffs } = useWorkingDiffs(gitScope, activeBase);

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

  const [commitMessage, setCommitMessage] = useState(getDefaultCommitMessage);
  const [isCommitting, setIsCommitting] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchSearchTerm, setBranchSearchTerm] = useState("");
  const branchSearchRef = useRef<HTMLInputElement>(null);

  // Fetch branches when dropdown opens
  useEffect(() => {
    if (branchDropdownOpen && gitScope) {
      listGitBranches(gitScope)
        .then((result) => setBranches(result.branches))
        .catch((err) =>
          console.error("[source-control] Failed to fetch branches:", err),
        );
    }
  }, [branchDropdownOpen, gitScope]);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (branchDropdownOpen) {
      setTimeout(() => branchSearchRef.current?.focus(), 0);
    } else {
      setBranchSearchTerm("");
    }
  }, [branchDropdownOpen]);

  const filteredBranches = useMemo(() => {
    if (!branchSearchTerm.trim()) return branches;
    const query = branchSearchTerm.toLowerCase();
    return branches.filter((b) => b.name.toLowerCase().includes(query));
  }, [branches, branchSearchTerm]);

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
  // working-changes tab.
  const handleOpenDiff = useCallback(() => {
    if (scopeTaskRunId) {
      openTab({ type: "diff", runId: scopeTaskRunId });
      return;
    }
    if (projectId) openTab({ type: "project-diff", projectId });
  }, [openTab, projectId, scopeTaskRunId]);

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
                  onClick={handleOpenDiff}
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

      {/* Branch / base-ref row. In "all" scope the dropdown picks the base ref
          to compare against (not a branch switch). */}
      <div className="relative px-3 py-2">
        <button
          type="button"
          onClick={() => setBranchDropdownOpen(!branchDropdownOpen)}
          disabled={scope !== "all"}
          className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-custom-background-80 disabled:hover:bg-transparent"
        >
          <div className="flex min-w-0 items-center gap-2">
            <GitBranch className="size-3.5 shrink-0 text-custom-text-300" />
            <span className="truncate text-custom-text-200">
              {currentBranch ?? "No branch"}
            </span>
            {scope === "all" && (
              <span className="shrink-0 text-custom-text-300">
                vs <span className="text-custom-text-200">{baseRef}</span>
              </span>
            )}
          </div>
          {scope === "all" && (
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-custom-text-300 transition-transform duration-150 ease-out",
                branchDropdownOpen && "rotate-180",
              )}
            />
          )}
        </button>

        {branchDropdownOpen && (
          <div className="absolute left-0 right-0 z-50 mt-1 mx-3 max-h-64 overflow-hidden rounded-xl border border-custom-border-200 bg-custom-background-100 shadow-sm">
            {/* Search input */}
            <div className="border-b border-custom-border-200 p-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-custom-text-300" />
                <input
                  ref={branchSearchRef}
                  type="text"
                  value={branchSearchTerm}
                  onChange={(e) => setBranchSearchTerm(e.target.value)}
                  placeholder="Search branches..."
                  className="w-full rounded border border-custom-border-200 bg-custom-background-90 py-1 pl-7 pr-2 text-sm text-custom-text-100 placeholder:text-custom-text-300 focus:border-custom-primary-100 focus:outline-none"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setBranchDropdownOpen(false);
                    }
                  }}
                />
              </div>
            </div>
            {/* Branch list */}
            <div className="max-h-48 overflow-y-auto">
              {filteredBranches.length === 0 ? (
                <div className="p-2 text-center text-sm text-custom-text-300">
                  No branches found
                </div>
              ) : (
                filteredBranches.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    onClick={() => {
                      // Pick the base ref to compare the branch against.
                      setBaseRefOverride(branch.name);
                      setBranchDropdownOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-sm hover:bg-custom-background-80",
                      branch.name === baseRef && "bg-custom-background-90",
                    )}
                  >
                    <span
                      className={cn(
                        "truncate",
                        branch.name === baseRef && "font-medium",
                      )}
                    >
                      {branch.name}
                    </span>
                    <div className="flex gap-1 text-xs">
                      {branch.name === baseRef && (
                        <span className="rounded bg-custom-primary-100/20 px-1 text-custom-primary-100">
                          base
                        </span>
                      )}
                      {branch.is_remote && (
                        <span className="rounded bg-custom-background-80 px-1 text-custom-text-300">
                          remote
                        </span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
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
            {scopedDiffs.map((entry) => (
              <FileItem
                key={entry.path}
                path={entry.path}
                status={changeKindToStatus(entry.diff.change)}
                additions={entry.diff.additions}
                deletions={entry.diff.deletions}
                onOpenFile={() => handleOpenFile(entry.path)}
                onOpenDiff={handleOpenDiff}
              />
            ))}
            {scopedDiffs.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-custom-text-300">
                No changes vs {baseRef}
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
            {status?.staged.map((file) => (
              <FileItem
                key={file.path}
                path={file.path}
                status={file.status}
                additions={countsByPath.get(file.path)?.additions}
                deletions={countsByPath.get(file.path)?.deletions}
                isStaged
                onUnstage={() => handleUnstageFile(file.path)}
                onOpenFile={() => handleOpenFile(file.path)}
                onOpenDiff={handleOpenDiff}
              />
            ))}
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
            {status?.modified.map((file) => (
              <FileItem
                key={file.path}
                path={file.path}
                status={file.status}
                additions={countsByPath.get(file.path)?.additions}
                deletions={countsByPath.get(file.path)?.deletions}
                onStage={() => handleStageFile(file.path)}
                onDiscard={() => handleDiscardFile(file.path)}
                onOpenFile={() => handleOpenFile(file.path)}
                onOpenDiff={handleOpenDiff}
              />
            ))}
            {status?.untracked.map((path) => (
              <FileItem
                key={path}
                path={path}
                isUntracked
                additions={countsByPath.get(path)?.additions}
                deletions={countsByPath.get(path)?.deletions}
                onStage={() => handleStageFile(path)}
                onOpenFile={() => handleOpenFile(path)}
                onOpenDiff={handleOpenDiff}
              />
            ))}
          </CollapsibleSection>
        </div>
      )}
    </div>
  );
};
