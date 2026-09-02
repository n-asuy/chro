import type { TranslationFunction } from "@/i18n";
import type { BaseCodingAgent, ReasoningEffort } from "@/lib/executor-client";
import { KeyboardHint } from "@/workspace-layout/components/keyboard-hint";
import { Button } from "@chro/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { ArrowUp, Loader2, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import type { PromptEditorHandle } from "../state/prompt-editor-store";
import {
  getPromptEditorScopeState,
  usePromptEditorStore,
} from "../state/prompt-editor-store";
import type { StoredTask } from "../types";
import {
  AtPopover,
  type AtPopoverHandle,
  type ModelOption,
  type ReasoningOption,
  type RuntimeOption,
} from "./prompt-editor/at-popover";
import { PromptEditor } from "./prompt-editor/prompt-editor";
import {
  SkillPopover,
  type SkillPopoverHandle,
} from "./prompt-editor/skill-popover";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

type PromptQueueItem = {
  id: string;
  prompt: string;
  imageIds: string[] | null;
  selectedSkillIds: string[];
  createdAt: number;
};

export function PromptEditorWithPopover({
  editorHandle,
  atPopoverRef,
  projectId,
  workspacePath,
  tasks,
  atActiveIndex,
  onActiveIndexChange,
  disabled,
  dropActive,
  onSubmit,
  onDrop,
  onPaste,
  t,
  runtimeValue,
  runtimeLabel,
  runtimeOptions,
  onSelectRuntime,
  modelValue,
  modelLabel,
  modelOptions,
  onSelectModel,
  reasoningValue,
  reasoningLabel,
  reasoningOptions,
  onSelectReasoning,
  showReasoning,
  runtimeLocked,
  modelLocked,
}: {
  editorHandle: PromptEditorHandle;
  atPopoverRef: React.RefObject<AtPopoverHandle | null>;
  projectId: string | null;
  workspacePath: string | null;
  tasks: StoredTask[];
  atActiveIndex: number;
  onActiveIndexChange: (index: number) => void;
  disabled: boolean;
  dropActive: boolean;
  onSubmit: () => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  t: TranslationFunction;
  runtimeValue: BaseCodingAgent | null;
  runtimeLabel: string | null;
  runtimeOptions: RuntimeOption[];
  onSelectRuntime: (value: BaseCodingAgent) => void;
  modelValue: string | null;
  modelLabel: string | null;
  modelOptions: ModelOption[];
  onSelectModel: (value: string) => void;
  reasoningValue: ReasoningEffort | null;
  reasoningLabel: string | null;
  reasoningOptions: ReasoningOption[];
  onSelectReasoning: (value: ReasoningEffort) => void;
  showReasoning: boolean;
  runtimeLocked: boolean;
  modelLocked: boolean;
}) {
  const popover = usePromptEditorStore(
    (s) => getPromptEditorScopeState(s, editorHandle.scopeId).popover,
  );
  const atQuery = usePromptEditorStore(
    (s) => getPromptEditorScopeState(s, editorHandle.scopeId).atQuery,
  );
  const skillQuery = usePromptEditorStore(
    (s) => getPromptEditorScopeState(s, editorHandle.scopeId).skillQuery,
  );
  const setPopover = usePromptEditorStore((s) => s.setPopover);
  const skillPopoverRef = useRef<SkillPopoverHandle | null>(null);
  const [skillActiveIndex, setSkillActiveIndex] = useState(0);

  return (
    <div className="relative">
      <SkillPopover
        ref={skillPopoverRef}
        open={popover === "skill"}
        query={skillQuery}
        workspacePath={workspacePath}
        onSelect={(skill) => editorHandle.addSkillPart(skill.id, skill.name)}
        onClose={() => setPopover(editorHandle.scopeId, null)}
        activeIndex={skillActiveIndex}
        onActiveIndexChange={setSkillActiveIndex}
      />
      <AtPopover
        ref={atPopoverRef}
        open={popover === "at"}
        query={atQuery}
        projectId={projectId}
        workspacePath={workspacePath}
        tasks={tasks}
        onSelect={(selection) => {
          if (selection.kind === "file") {
            editorHandle.addFilePart(
              selection.path,
              selection.isFile,
              selection.branch,
            );
          } else if (selection.kind === "session") {
            editorHandle.addSessionPart(selection.taskId, selection.branch);
          } else {
            editorHandle.addSkillPart(selection.id, selection.name);
          }
        }}
        onClose={() => setPopover(editorHandle.scopeId, null)}
        activeIndex={atActiveIndex}
        onActiveIndexChange={onActiveIndexChange}
        runtimeValue={runtimeValue}
        runtimeLabel={runtimeLabel}
        runtimeOptions={runtimeOptions}
        onSelectRuntime={(value) => {
          editorHandle.removeActiveTrigger({ keepPopoverOpen: true });
          onSelectRuntime(value);
        }}
        modelValue={modelValue}
        modelLabel={modelLabel}
        modelOptions={modelOptions}
        onSelectModel={(value) => {
          editorHandle.removeActiveTrigger({ keepPopoverOpen: true });
          onSelectModel(value);
        }}
        reasoningValue={reasoningValue}
        reasoningLabel={reasoningLabel}
        reasoningOptions={reasoningOptions}
        onSelectReasoning={(value) => {
          editorHandle.removeActiveTrigger({ keepPopoverOpen: true });
          onSelectReasoning(value);
        }}
        showReasoning={showReasoning}
        runtimeLocked={runtimeLocked}
        modelLocked={modelLocked}
      />
      <PromptEditor
        handle={editorHandle}
        disabled={disabled}
        placeholder={`${t("inputPlaceholder")} @ for files, / for skills`}
        dropPlaceholder={t("dropFilesPlaceholder")}
        dropActive={dropActive}
        onSubmit={onSubmit}
        onPopoverKeyDown={(e) => {
          if (popover === "skill") {
            return skillPopoverRef.current?.handleKeyDown(e) ?? false;
          }
          return atPopoverRef.current?.handleKeyDown(e) ?? false;
        }}
        onDrop={onDrop}
        onPaste={onPaste}
      />
    </div>
  );
}

export function SendButtonWithState({
  editorHandle,
  isSending,
  isStopping,
  canSend,
  isUploading,
  onSend,
  onCancel,
  t,
}: {
  editorHandle: PromptEditorHandle;
  isSending: boolean;
  isStopping: boolean;
  canSend: boolean;
  isUploading: boolean;
  onSend: () => void;
  onCancel: () => void;
  t: TranslationFunction;
}) {
  const isEmpty = usePromptEditorStore(
    (s) => getPromptEditorScopeState(s, editorHandle.scopeId).isEmpty,
  );
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
            // The submit chord, spelled with the platform's own modifier —
            // hardcoding ⌘ misnames the key everywhere but macOS.
            <KeyboardHint keys={["mod", "Enter"]} />
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
