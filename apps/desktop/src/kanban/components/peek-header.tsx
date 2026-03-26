
import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@chro/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import {
  FileDiff,
  GitMerge,
  GitPullRequestArrow,
  Loader2,
  Maximize2,
  Minimize2,
  MoveRight,
  Pencil,
} from "lucide-react";
import { useLanguage } from "@/i18n";
import type { BoardIssue } from "@/kanban/types";
import { cn } from "@/lib/cn";
import type { DiffActionState } from "./task-session-panel";

export type PeekMode = "side-peek" | "modal" | "full-screen";

interface Props {
  issue?: BoardIssue;
  peekMode: PeekMode;
  onClose: () => void;
  onToggleFullScreen?: () => void;
  diffActions?: DiffActionState | null;
  onTitleChange?: (newTitle: string) => Promise<void>;
}

const shortIdFromUuid = (id?: string | null, length = 8): string | null => {
  if (!id) return null;
  const compact = id.replace(/-/g, "");
  if (!compact) return null;
  return compact.slice(0, length).toLowerCase();
};

export const PeekHeader: React.FC<Props> = ({
  issue,
  peekMode,
  onClose,
  onToggleFullScreen,
  diffActions,
  onTitleChange,
}) => {
  const { t } = useLanguage();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(issue?.title ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditValue(issue?.title ?? "");
  }, [issue?.title]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === issue?.title) {
      setIsEditing(false);
      setEditValue(issue?.title ?? "");
      return;
    }

    if (onTitleChange) {
      setIsSaving(true);
      try {
        await onTitleChange(trimmed);
      } finally {
        setIsSaving(false);
      }
    }
    setIsEditing(false);
  }, [editValue, issue?.title, onTitleChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        if (e.nativeEvent.isComposing) {
          return;
        }
        e.preventDefault();
        void handleSave();
      } else if (e.key === "Escape") {
        setIsEditing(false);
        setEditValue(issue?.title ?? "");
      }
    },
    [handleSave, issue?.title],
  );

  const canOpenDiffViewer = diffActions?.canOpenDiffViewer ?? false;
  const canMergeDiffs = diffActions?.canMergeDiffs ?? false;
  const canRebase = diffActions?.canRebase ?? false;
  const isMergingDiffs = diffActions?.isMergingDiffs ?? false;
  const isMerged = diffActions?.isMerged ?? false;
  const isRebasing = diffActions?.isRebasing ?? false;
  const commitsBehind = diffActions?.commitsBehind ?? 0;
  const hasDiffs = Boolean(diffActions);

  const mergeButtonLabel = isMerged
    ? t("diffMergedLabel")
    : isMergingDiffs
      ? t("diffMergingLabel")
      : t("diffMergeButtonLabel");
  const taskShortId = shortIdFromUuid(issue?.id);
  const taskDisplayId = taskShortId ?? issue?.id;

  return (
    <div
      className={cn(
        "font-workspace text-[12px] leading-[1.35] flex w-full flex-wrap items-center justify-between gap-4",
        peekMode === "full-screen" ? "px-6 py-4" : "px-4 py-3",
      )}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-2 text-custom-sidebar-text-200 hover:bg-custom-sidebar-background-90 active:bg-custom-sidebar-background-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-custom-border-300"
          aria-label="Close"
        >
          <MoveRight size={16} />
        </button>
        {onToggleFullScreen && (
          <button
            type="button"
            onClick={onToggleFullScreen}
            className="rounded-md p-2 text-custom-sidebar-text-200 hover:bg-custom-sidebar-background-90 active:bg-custom-sidebar-background-80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-custom-border-300"
            aria-label={peekMode === "full-screen" ? "Exit full screen" : "Full screen"}
          >
            {peekMode === "full-screen" ? (
              <Minimize2 size={16} />
            ) : (
              <Maximize2 size={16} />
            )}
          </button>
        )}
        <div className="flex-1 min-w-0 text-[12px] font-medium text-foreground">
          {issue?.title || isEditing ? (
            isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => void handleSave()}
                onKeyDown={handleKeyDown}
                disabled={isSaving}
                className="w-full bg-transparent text-[12px] font-medium text-foreground outline-none border-b border-border focus:border-primary py-0.5"
              />
            ) : (
              <div className="group flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onTitleChange && setIsEditing(true)}
                  className={cn(
                    "whitespace-pre-line text-[12px] leading-[1.35] text-left",
                    onTitleChange &&
                      "hover:bg-muted/50 rounded px-1 -mx-1 py-0.5 cursor-text",
                  )}
                >
                  {issue?.title}
                </button>
                {onTitleChange && (
                  <button
                    type="button"
                    onClick={() => setIsEditing(true)}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity p-0.5 rounded hover:bg-muted/50"
                    aria-label="Edit title"
                  >
                    <Pencil size={11} />
                  </button>
                )}
              </div>
            )
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
        {issue && taskDisplayId ? (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex cursor-default items-center gap-1.5">
                  <span className="text-[10px] tracking-[0.08em] text-muted-foreground">
                    ID
                  </span>
                  <span className="font-mono text-[12px] text-foreground">
                    {taskDisplayId}
                  </span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-[11px]">
                {issue.branch ? (
                  <span>Branch: {issue.branch}</span>
                ) : (
                  <span>ID: {issue.id}</span>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {hasDiffs ? (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canRebase}
                  onClick={() => diffActions?.onRebase()}
                  className="inline-flex items-center gap-1.5 text-[12px]"
                >
                  {isRebasing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <GitPullRequestArrow className="h-3.5 w-3.5" />
                  )}
                  <span>
                    {isRebasing
                      ? t("rebaseInProgressLabel")
                      : t("rebaseButtonLabel")}
                  </span>
                  {commitsBehind > 0 && !isRebasing && (
                    <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-medium">
                      ↓{commitsBehind}
                    </span>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {commitsBehind > 0
                  ? `${commitsBehind} commit${commitsBehind !== 1 ? "s" : ""} behind`
                  : t("rebaseBranch")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canOpenDiffViewer}
                  onClick={() => diffActions?.onOpenDiffViewer()}
                  className="inline-flex items-center gap-1.5 text-[12px]"
                >
                  <FileDiff className="h-3.5 w-3.5" />
                  <span>{t("openDiffViewerLabel")}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("openDiff")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canMergeDiffs}
                  onClick={() => void diffActions?.onMergeDiffs()}
                  className="inline-flex items-center gap-1.5 text-[12px]"
                >
                  {isMergingDiffs ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <GitMerge className="h-3.5 w-3.5" />
                  )}
                  <span>{mergeButtonLabel}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("mergeBranch")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </div>
    </div>
  );
};
