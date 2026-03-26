
import { useCallback } from "react";

import type { BoardIssue } from "@/kanban/types";
import { useWorkspaceBoardContext } from "@/kanban/providers";
import { useTaskRunsStore } from "@/kanban/state/task-runs-store";
import { desktopFetch } from "@/lib/backend-client";
import { cn } from "@/lib/cn";

import { GlowingBorder } from "./glowing-border";
import { IssueCardActions } from "./issue-card-actions";

interface Props {
  issue: BoardIssue;
  isDragging?: boolean;
  isOverlay?: boolean;
}

export const KanbanIssueCard: React.FC<Props> = ({
  issue,
  isDragging = false,
  isOverlay = false,
}) => {
  const { setPeekIssue, peekIssueId, deleteIssue } = useWorkspaceBoardContext();

  const getCancelableRunId = useTaskRunsStore((s) => s.getCancelableRunId);
  const loadRunsForTask = useTaskRunsStore((s) => s.loadRunsForTask);

  const isPeekActive = !isOverlay && peekIssueId === issue.id;
  const activeRunId = getCancelableRunId(issue.id);
  const isRunning = Boolean(issue.activeSessionId || activeRunId);

  const handleSelectIssue = () => {
    if (isOverlay) return;
    setPeekIssue(issue.id);
  };

  const handleDelete = useCallback(async () => {
    try {
      const runs = await loadRunsForTask(issue.id);
      const cancelableRunId =
        runs.find((r) => r.status === "running" || r.status === "pending")
          ?.id ?? null;

      if (cancelableRunId) {
        await desktopFetch(`/rpc/task-runs/${cancelableRunId}/cancel`, {
          method: "POST",
        });
      }

      await deleteIssue(issue.id);
    } catch {
      // Deletion failed silently - task remains in board
    }
  }, [deleteIssue, issue.id, loadRunsForTask]);

  const CardContent = (
    <div
      className={cn(
        "relative block w-full rounded border-[1px] border-custom-border-200 bg-custom-background-100 outline-[0.5px] outline-transparent transition-all hover:border-custom-border-400 focus-within:border-custom-primary-100 focus-within:ring-2 focus-within:ring-custom-primary-100/45 focus-within:ring-offset-1 focus-within:ring-offset-custom-background-100",
        {
          "border-custom-primary-100 shadow-custom-shadow-sm": isDragging,
          "shadow-custom-shadow-md": isOverlay,
          "border-custom-primary-100 ring-2 ring-custom-primary-100/45 ring-offset-1 ring-offset-custom-background-100":
            isPeekActive,
        },
      )}
    >
      {!isOverlay && (
        <IssueCardActions
          issueId={issue.id}
          isPeekActive={isPeekActive}
          onDelete={handleDelete}
        />
      )}
      <button
        type="button"
        className="w-full rounded text-left focus-visible:outline-none"
        onClick={handleSelectIssue}
        disabled={isOverlay}
      >
        <div className="space-y-2 py-2 pl-3 pr-9">
          <div className="line-clamp-1 text-[11px] text-custom-text-300">
            {issue.key}
          </div>
          <div className="mb-1.5 line-clamp-2 text-[13px] font-semibold text-custom-text-100">
            {issue.title}
          </div>
        </div>
      </button>
    </div>
  );

  return (
    <div
      className={cn(
        "group/kanban-block relative p-1.5 font-workspace text-[12px] leading-[1.35]",
        { "pointer-events-none": isOverlay },
      )}
    >
      {isRunning ? <GlowingBorder>{CardContent}</GlowingBorder> : CardContent}
    </div>
  );
};
