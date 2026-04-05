import type { TranslationFunction } from "@/i18n";
import { Button } from "@chro/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { ArrowUp, Command, Loader2, Square, X } from "lucide-react";
import {
  AgentUserQuestion,
  type AgentUserQuestionHandle,
} from "./agent-user-question";
import { AtPopover, type AtPopoverHandle } from "./prompt-editor/at-popover";
import { PromptEditor } from "./prompt-editor/prompt-editor";
import type { StoredTask } from "../types";
import type { PromptEditorHandle } from "../state/prompt-editor-store";
import type { PendingUserQuestions } from "../state/user-question-store";
import { usePromptEditorStore } from "../state/prompt-editor-store";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

type PromptQueueItem = {
  id: string;
  prompt: string;
  imageIds: string[] | null;
  createdAt: number;
};

export function PromptEditorWithPopover({
  editorHandle,
  atPopoverRef,
  projectId,
  workspacePath,
  containerRef,
  tasks,
  atActiveIndex,
  onActiveIndexChange,
  disabled,
  isAttachingSession,
  onSubmit,
  onDrop,
  onPaste,
  t,
}: {
  editorHandle: PromptEditorHandle;
  atPopoverRef: React.RefObject<AtPopoverHandle | null>;
  projectId: string | null;
  workspacePath: string | null;
  containerRef: string | null;
  tasks: StoredTask[];
  atActiveIndex: number;
  onActiveIndexChange: (index: number) => void;
  disabled: boolean;
  isAttachingSession: boolean;
  onSubmit: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  t: TranslationFunction;
}) {
  const popover = usePromptEditorStore((s) => s.popover);
  const atQuery = usePromptEditorStore((s) => s.atQuery);
  const setPopover = usePromptEditorStore((s) => s.setPopover);

  return (
    <div className="relative">
      <AtPopover
        ref={atPopoverRef}
        open={popover === "at"}
        query={atQuery}
        projectId={projectId}
        workspacePath={workspacePath}
        containerRef={containerRef}
        tasks={tasks}
        onSelect={(path, isFile, branch) =>
          editorHandle.addFilePart(path, isFile, branch)
        }
        onClose={() => setPopover(null)}
        activeIndex={atActiveIndex}
        onActiveIndexChange={onActiveIndexChange}
      />
      {isAttachingSession ? (
        <div className="mb-2 inline-flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("sessionAttachLoading")}</span>
        </div>
      ) : null}
      <PromptEditor
        handle={editorHandle}
        disabled={disabled}
        placeholder={`${t("inputPlaceholder")} @ to add files`}
        onSubmit={onSubmit}
        onPopoverKeyDown={(e) =>
          atPopoverRef.current?.handleKeyDown(e) ?? false
        }
        onDrop={onDrop}
        onPaste={onPaste}
      />
    </div>
  );
}

export function SendButtonWithState({
  isSending,
  isStopping,
  canSend,
  isUploading,
  onSend,
  onCancel,
  t,
}: {
  isSending: boolean;
  isStopping: boolean;
  canSend: boolean;
  isUploading: boolean;
  onSend: () => void;
  onCancel: () => void;
  t: TranslationFunction;
}) {
  const isEmpty = usePromptEditorStore((s) => s.isEmpty);
  const isDisabled = isSending
    ? isStopping
    : !canSend || isEmpty || isUploading;

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={isSending ? onCancel : onSend}
            disabled={isDisabled}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition",
              isSending
                ? "bg-primary/10 text-primary"
                : isDisabled
                  ? "bg-muted text-muted-foreground"
                  : "bg-primary text-white hover:!bg-primary/90 hover:!text-white",
              "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:bg-muted disabled:hover:text-muted-foreground disabled:opacity-100",
            )}
            aria-label={
              isSending ? t("stopButtonLabel") : t("sendShortcutAria")
            }
          >
            {isStopping ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSending ? (
              <Square className="h-4 w-4" />
            ) : (
              <ArrowUp className="h-4 w-4" strokeWidth={3} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="text-[11px]">
          {isSending ? (
            <span>{t("stopButtonLabel")}</span>
          ) : (
            <span className="flex items-center gap-1">
              <Command className="h-3.5 w-3.5" />
              <span className="text-[11px] font-medium">+</span>
              <span>Enter</span>
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PromptQueueIndicator({
  queue,
  onRemove,
  onSendNow,
  t,
}: {
  queue: PromptQueueItem[];
  onRemove: (itemId: string) => void;
  onSendNow: (itemId: string) => void;
  t: TranslationFunction;
}) {
  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="rounded-xl border border-border/80 bg-muted/30">
      <div className="flex h-8 items-center px-3 text-xs text-muted-foreground">
        {t("queueItemsLabel", { count: queue.length })}
      </div>
      <div className="max-h-40 overflow-y-auto border-t border-border/70">
        {queue.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/50"
          >
            <span className="line-clamp-1 flex-1 text-foreground">
              {item.prompt}
            </span>
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSendNow(item.id)}
                    className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    aria-label={t("queueSendNowAria")}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  {t("queueSendNowAria")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider delayDuration={120}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    aria-label={t("queueRemoveAria")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-[11px]">
                  {t("queueRemoveAria")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentUserQuestionWithEditorState({
  questionRef,
  pendingQuestions,
  onAnswer,
  onSkip,
}: {
  questionRef: React.RefObject<AgentUserQuestionHandle | null>;
  pendingQuestions: PendingUserQuestions;
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const hasText = usePromptEditorStore((s) => s.hasText);

  return (
    <AgentUserQuestion
      ref={questionRef}
      pendingQuestions={pendingQuestions}
      onAnswer={onAnswer}
      onSkip={onSkip}
      hasCustomText={hasText}
    />
  );
}
