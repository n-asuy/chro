import type { TranslationFunction } from "@/i18n";
import { Button } from "@chro/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { PanelLeft, Pencil } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

type SessionHeaderProps = {
  taskTitle?: string | null;
  /** Consolidated environment popover (changes, worktree, base, rebase, merge). */
  environmentControl?: ReactNode;
  onTitleChange?: (newTitle: string) => Promise<void>;
  /** Whether the sidebar is collapsed */
  isSidebarCollapsed?: boolean;
  /** Handler to open the sidebar */
  onOpenSidebar?: () => void;
  t: TranslationFunction;
  containerClassName?: string;
};

export function SessionHeader({
  taskTitle,
  environmentControl,
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
      {environmentControl ? (
        <div className="flex flex-wrap items-center gap-2">
          {environmentControl}
        </div>
      ) : null}
    </div>
  );
}
