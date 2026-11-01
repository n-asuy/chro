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
import { ArrowUp, ListPlus, Loader2, Square } from "lucide-react";
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

function ComposerRoundButton({
  label,
  tooltip,
  onClick,
  disabled,
  emphasis,
  children,
}: {
  label: string;
  tooltip: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  /** "solid" for the action that submits, "soft" for Stop. */
  emphasis: "solid" | "soft";
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full transition",
            emphasis === "soft"
              ? "bg-primary/10 text-primary"
              : "bg-primary text-white hover:!bg-primary/90 hover:!text-white",
            "disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:hover:bg-muted disabled:hover:text-muted-foreground disabled:opacity-100",
          )}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="text-[11px]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Send, or while a turn runs, Stop. Writing during a turn adds a Queue button
 * beside Stop: the message waits in the session's queue and becomes the next
 * turn. `onSend` decides between sending and queuing; the submit chord does
 * the same.
 */
export function SendButtonWithState({
  editorHandle,
  isSending,
  isStopping,
  canSend,
  canQueue,
  isUploading,
  onSend,
  onCancel,
  t,
}: {
  editorHandle: PromptEditorHandle;
  isSending: boolean;
  isStopping: boolean;
  canSend: boolean;
  canQueue: boolean;
  isUploading: boolean;
  onSend: () => void;
  onCancel: () => void;
  t: TranslationFunction;
}) {
  const isEmpty = usePromptEditorStore(
    (s) => getPromptEditorScopeState(s, editorHandle.scopeId).isEmpty,
  );
  // The submit chord, spelled with the platform's own modifier — hardcoding
  // ⌘ misnames the key everywhere but macOS.
  const submitChord = <KeyboardHint keys={["mod", "Enter"]} />;

  if (!isSending) {
    return (
      <TooltipProvider delayDuration={120}>
        <ComposerRoundButton
          label={t("sendShortcutAria")}
          tooltip={submitChord}
          onClick={onSend}
          disabled={!canSend || isEmpty || isUploading}
          emphasis="solid"
        >
          <ArrowUp className="h-4 w-4" strokeWidth={3} />
        </ComposerRoundButton>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex items-center gap-1.5">
        {canQueue && !isEmpty ? (
          <ComposerRoundButton
            label={t("queueButtonLabel")}
            tooltip={
              <span className="flex items-center gap-1.5">
                {t("queueButtonLabel")}
                {submitChord}
              </span>
            }
            onClick={onSend}
            disabled={isUploading}
            emphasis="solid"
          >
            <ListPlus className="h-4 w-4" strokeWidth={2.5} />
          </ComposerRoundButton>
        ) : null}
        <ComposerRoundButton
          label={t("stopButtonLabel")}
          tooltip={<span>{t("stopButtonLabel")}</span>}
          onClick={onCancel}
          disabled={isStopping}
          emphasis="soft"
        >
          {isStopping ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </ComposerRoundButton>
      </div>
    </TooltipProvider>
  );
}
