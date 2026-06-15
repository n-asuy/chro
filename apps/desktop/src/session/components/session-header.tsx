import type { TranslationFunction } from "@/i18n";
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
  PanelLeft,
  Pencil,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

const shortIdFromUuid = (id?: string | null, length = 8): string | null => {
  if (!id) return null;
  const compact = id.replace(/-/g, "");
  if (!compact) return null;
  return compact.slice(0, length).toLowerCase();
};

type SessionHeaderProps = {
  taskId?: string | null;
  taskTitle?: string | null;
  taskBranch?: string | null;
  hasDiffs: boolean;
  canRebase: boolean;
  canMergeDiffs: boolean;
  isRebasing: boolean;
  isMergingDiffs: boolean;
  /** Commits behind the default branch for diff action state. */
  commitsBehind?: number;
  onOpenDiffViewer: () => void;
  onRebase: () => void;
  onMergeDiffs: () => void;
  onTitleChange?: (newTitle: string) => Promise<void>;
  /** Whether the sidebar is collapsed */
  isSidebarCollapsed?: boolean;
  /** Handler to open the sidebar */
  onOpenSidebar?: () => void;
  t: TranslationFunction;
  containerClassName?: string;
};

export function SessionHeader({
  taskId,
  taskTitle,
  taskBranch,
  hasDiffs,
  canRebase,
  canMergeDiffs,
  isRebasing,
  isMergingDiffs,
  commitsBehind = 0,
  onOpenDiffViewer,
  onRebase,
  onMergeDiffs,
  onTitleChange,
  isSidebarCollapsed,
  onOpenSidebar,
  t,
  containerClassName,
}: SessionHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(taskTitle ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setEditValue(taskTitle ?? "");
  }, [taskTitle]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSave = useCallback(async () => {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === taskTitle) {
      setIsEditing(false);
      setEditValue(taskTitle ?? "");
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
  }, [editValue, taskTitle, onTitleChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        // Skip if IME composition is in progress
        if (e.nativeEvent.isComposing) {
          return;
        }
        e.preventDefault();
        void handleSave();
      } else if (e.key === "Escape") {
        setIsEditing(false);
        setEditValue(taskTitle ?? "");
      }
    },
    [handleSave, taskTitle],
  );

  const taskShortId = shortIdFromUuid(taskId);
  const taskDisplayId = taskShortId ?? taskId;
  return (
    <div
      className={cn(
        "font-workspace text-[12px] leading-[1.35] flex w-full flex-wrap items-center justify-between gap-4 px-4 py-3",
        containerClassName,
      )}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {isSidebarCollapsed && onOpenSidebar && (
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={onOpenSidebar}
                  className="h-7 w-7 shrink-0"
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("toggleSessionListAria")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="flex-1 min-w-0 text-[12px] font-medium text-foreground">
          {taskTitle || isEditing ? (
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
              <div className="group flex min-w-0 items-start gap-1.5">
                <button
                  type="button"
                  onClick={() => onTitleChange && setIsEditing(true)}
                  title={taskTitle ?? undefined}
                  className={cn(
                    "min-w-0 flex-1 whitespace-pre-line break-words text-[12px] leading-[1.35] text-left line-clamp-2",
                    onTitleChange &&
                      "hover:bg-muted/50 rounded px-1 -mx-1 py-0.5 cursor-text",
                  )}
                >
                  {taskTitle}
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
        {taskDisplayId ? (
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
                {taskBranch ? (
                  <span>Branch: {taskBranch}</span>
                ) : (
                  <span>ID: {taskId}</span>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canRebase}
                onClick={onRebase}
                className="inline-flex h-7 items-center gap-1.5 rounded-sm text-[12px]"
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
          {hasDiffs && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onOpenDiffViewer}
                    className="inline-flex h-7 items-center gap-1.5 rounded-sm text-[12px]"
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
                    onClick={onMergeDiffs}
                    className="inline-flex h-7 items-center gap-1.5 rounded-sm text-[12px]"
                  >
                    {isMergingDiffs ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="h-3.5 w-3.5" />
                    )}
                    <span>
                      {isMergingDiffs
                        ? t("diffMergingLabel")
                        : t("diffMergeButtonLabel")}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">
                  {t("mergeBranch")}
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </TooltipProvider>
      </div>
    </div>
  );
}
