import { cn } from "@/lib/cn";
import {
  type BranchInfo,
  type FileChangeStatus,
  listGitBranches,
} from "@/lib/git-client";
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
  FileEdit,
  FilePlus,
  FileX,
  GitBranch,
  Minus,
  PanelRightClose,
  Plus,
  RefreshCw,
  Search,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectContext } from "../../context/project-context";
import { useGitStatus } from "../../hooks/use-git-status";
import { useFilesStore } from "../../state/files-store";

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
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
  onOpenFile?: () => void;
  isStaged?: boolean;
}

const FileItem = ({
  path,
  status,
  isUntracked,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
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
      className="group flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-custom-background-80"
      title={path}
    >
      <div className="flex-shrink-0">
        {isUntracked ? (
          <FilePlus className="size-4 text-green-500" />
        ) : status ? (
          getStatusIcon(status)
        ) : (
          <File className="size-4 text-custom-text-300" />
        )}
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <span className="block truncate text-custom-text-100">{fileName}</span>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
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

type SourceControlPanelProps = {
  onClose?: () => void;
};

export const SourceControlPanel = ({ onClose }: SourceControlPanelProps) => {
  const { projectId } = useProjectContext();
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
  } = useGitStatus({ projectId });

  const openFileInEditor = useFilesStore((state) => state.openFile);

  const [commitMessage, setCommitMessage] = useState(getDefaultCommitMessage);
  const [isCommitting, setIsCommitting] = useState(false);
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchSearchTerm, setBranchSearchTerm] = useState("");
  const branchSearchRef = useRef<HTMLInputElement>(null);

  // Fetch branches when dropdown opens
  useEffect(() => {
    if (branchDropdownOpen && projectId) {
      listGitBranches(projectId)
        .then(setBranches)
        .catch((err) =>
          console.error("[source-control] Failed to fetch branches:", err),
        );
    }
  }, [branchDropdownOpen, projectId]);

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
      openFileInEditor(normalizedPath);
    },
    [openFileInEditor],
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
    <div className="flex h-full flex-col">
      {/* Header with toolbar */}
      <div className="flex h-11 items-center justify-between border-b border-custom-border-200 px-2">
        {onClose && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100"
                  aria-label="Close panel"
                >
                  <PanelRightClose className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                Close panel
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCommit}
                  disabled={isLoading || isCommitting || !canCommit}
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
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
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
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
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Unstage All"
                >
                  <Minus className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                Unstage All
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handlePush}
                  disabled={isLoading}
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
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
                  className="inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40"
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
                    "inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-custom-text-300 transition hover:bg-custom-background-80 hover:text-custom-text-100 disabled:pointer-events-none disabled:opacity-40",
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

      {/* Branch selector dropdown */}
      <div className="relative border-b border-custom-border-200 px-3 py-2">
        <button
          type="button"
          onClick={() => setBranchDropdownOpen(!branchDropdownOpen)}
          className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-custom-background-80"
        >
          <div className="flex items-center gap-2">
            <GitBranch className="size-3.5 text-custom-text-300" />
            <span className="text-custom-text-200">
              {currentBranch ?? "No branch"}
            </span>
          </div>
          <ChevronDown
            className={cn(
              "size-3.5 text-custom-text-300",
              branchDropdownOpen && "rotate-180",
            )}
          />
        </button>

        {branchDropdownOpen && (
          <div className="absolute left-0 right-0 z-50 mt-1 mx-3 max-h-64 overflow-hidden rounded border border-custom-border-200 bg-custom-background-100 shadow-lg">
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
                      // Branch switching not yet implemented - just close for now
                      setBranchDropdownOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-sm hover:bg-custom-background-80",
                      branch.is_current && "bg-custom-background-90",
                    )}
                  >
                    <span
                      className={cn(
                        "truncate",
                        branch.is_current && "font-medium",
                      )}
                    >
                      {branch.name}
                    </span>
                    <div className="flex gap-1 text-xs">
                      {branch.is_current && (
                        <span className="rounded bg-custom-primary-100/20 px-1 text-custom-primary-100">
                          current
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
      <div className="border-b border-custom-border-200 px-3 py-2">
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={handleCommitMessageFocus}
          placeholder="Commit message (Ctrl+Enter to commit)"
          className="w-full resize-none rounded border border-custom-border-200 bg-custom-background-100 px-2 py-1.5 text-sm text-custom-text-100 placeholder:text-custom-text-300 focus:border-custom-primary-100 focus:outline-none"
          rows={2}
        />
      </div>

      {/* File lists */}
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
              isStaged
              onUnstage={() => handleUnstageFile(file.path)}
              onOpenFile={() => handleOpenFile(file.path)}
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
              onStage={() => handleStageFile(file.path)}
              onDiscard={() => handleDiscardFile(file.path)}
              onOpenFile={() => handleOpenFile(file.path)}
            />
          ))}
          {status?.untracked.map((path) => (
            <FileItem
              key={path}
              path={path}
              isUntracked
              onStage={() => handleStageFile(path)}
              onOpenFile={() => handleOpenFile(path)}
            />
          ))}
        </CollapsibleSection>
      </div>
    </div>
  );
};
