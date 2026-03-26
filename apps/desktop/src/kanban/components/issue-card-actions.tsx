
import { useCallback, useState, type SyntheticEvent } from "react";
import { CircleStop, Loader2, MoreHorizontal, Play, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";

import { taskApi } from "@/kanban/api/task-api";
import { useWorkspaceBoardContext } from "@/kanban/providers";
import { useTaskRunsStore } from "@/kanban/state/task-runs-store";
import { cn } from "@/lib/cn";

interface IssueCardActionsProps {
  issueId: string;
  isPeekActive: boolean;
  onDelete: () => void | Promise<void>;
}

export const IssueCardActions: React.FC<IssueCardActionsProps> = ({
  issueId,
  isPeekActive,
  onDelete,
}) => {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isStoppingRun, setIsStoppingRun] = useState(false);
  const [isStartingRun, setIsStartingRun] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { workspacePath } = useWorkspaceBoardContext();
  const loadRunsForTask = useTaskRunsStore((s) => s.loadRunsForTask);
  const cancelRun = useTaskRunsStore((s) => s.cancelRun);
  const getCancelableRunId = useTaskRunsStore((s) => s.getCancelableRunId);
  const loadingTaskIds = useTaskRunsStore((s) => s.loadingTaskIds);

  const activeRunId = getCancelableRunId(issueId);
  const isLoadingRuns = loadingTaskIds.has(issueId);
  const isStopDisabled = !activeRunId || isStoppingRun;
  const canStartRun = !activeRunId && !isStartingRun && workspacePath;

  const handleDropdownOpenChange = (open: boolean) => {
    setIsMenuOpen(open);
    if (open) {
      void loadRunsForTask(issueId);
    }
  };

  const handleStopExecution = useCallback(async () => {
    if (!activeRunId || isStoppingRun) return;
    setIsStoppingRun(true);
    setActionError(null);
    try {
      await cancelRun(activeRunId, issueId);
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to stop run",
      );
    } finally {
      setIsStoppingRun(false);
    }
  }, [activeRunId, cancelRun, issueId, isStoppingRun]);

  const handleStartExecution = useCallback(async () => {
    if (!canStartRun || !workspacePath) return;
    setIsStartingRun(true);
    setActionError(null);
    try {
      await taskApi.startClaudeExecution(workspacePath, issueId, {
        useWorktree: true,
      });
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Failed to start run",
      );
    } finally {
      setIsStartingRun(false);
    }
  }, [canStartRun, issueId, workspacePath]);

  const handleDelete = () => {
    setActionError(null);
    void onDelete();
  };

  const stopPropagation = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  return (
    <DropdownMenu open={isMenuOpen} onOpenChange={handleDropdownOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open task actions"
          className={cn(
            "absolute right-2 top-1.5 z-10 inline-flex h-6 w-6 items-center justify-center rounded border border-transparent bg-custom-background-80/70 text-custom-text-300 opacity-0 transition hover:border-custom-border-300 hover:text-custom-text-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-custom-primary-100 group-hover/kanban-block:opacity-100 data-[state=open]:opacity-100",
            { "opacity-100": isPeekActive },
          )}
          disabled={isStoppingRun}
          onClick={stopPropagation}
          onPointerDown={stopPropagation}
        >
          {isStoppingRun ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="z-20 w-48 rounded border border-custom-border-200 bg-custom-background-100 p-1 shadow-lg"
      >
        <DropdownMenuLabel className="font-workspace px-2 py-1 text-[10px] uppercase tracking-[0.15em] text-custom-text-300">
          Task
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void handleStartExecution();
          }}
          disabled={!canStartRun}
          className="font-workspace flex items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 disabled:opacity-60"
        >
          {isStartingRun ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5 shrink-0" />
          )}
          <span>{isStartingRun ? "Starting..." : "Run task"}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void handleStopExecution();
          }}
          disabled={isStopDisabled}
          className="font-workspace flex items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 disabled:opacity-60"
        >
          <CircleStop className="h-3.5 w-3.5 shrink-0" />
          <span>{isStoppingRun ? "Stopping..." : "Stop Claude run"}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            handleDelete();
          }}
          className="font-workspace flex items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-red-50 focus:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
          <span>Delete task</span>
        </DropdownMenuItem>
        {isLoadingRuns ? (
          <div className="px-2 py-1 text-[11px] text-custom-text-300">
            Syncing status...
          </div>
        ) : null}
        {actionError ? (
          <div className="px-2 py-1 text-[11px] text-red-600">
            {actionError}
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
