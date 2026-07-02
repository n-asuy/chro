import { cn } from "@chro/ui/utils";
import { useCallback } from "react";
import type { PromptEditorHandle } from "../../state/prompt-editor-store";
import {
  getPromptEditorScopeState,
  usePromptEditorStore,
} from "../../state/prompt-editor-store";

interface PromptEditorProps {
  handle: PromptEditorHandle;
  disabled?: boolean;
  placeholder?: string;
  /** Shown instead of `placeholder` while files are dragged over the composer. */
  dropPlaceholder?: string;
  /** Whether files are currently being dragged over the composer. */
  dropActive?: boolean;
  onSubmit: () => void;
  onPopoverKeyDown?: (e: React.KeyboardEvent) => boolean;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void;
}

const isMacLikePlatform = () => {
  if (typeof window === "undefined") return false;
  if ("userAgentData" in navigator) {
    const uad = navigator.userAgentData as { platform?: string } | undefined;
    if (uad?.platform) {
      return /mac/i.test(uad.platform);
    }
  }
  return /mac|ipod|iphone|ipad/i.test(navigator.userAgent);
};

export function PromptEditor({
  handle,
  disabled = false,
  placeholder = "Input task",
  dropPlaceholder,
  dropActive = false,
  onSubmit,
  onPopoverKeyDown,
  onDrop,
  onPaste,
}: PromptEditorProps) {
  // Subscribe only to popover (not the whole store)
  const popover = usePromptEditorStore(
    (s) => getPromptEditorScopeState(s, handle.scopeId).popover,
  );
  const isEmpty = usePromptEditorStore(
    (s) => getPromptEditorScopeState(s, handle.scopeId).isEmpty,
  );

  const setEditorNode = useCallback(
    (node: HTMLDivElement | null) => {
      handle.editorRef.current = node;
      if (node) {
        handle.syncDomFromStore();
      }
    },
    [handle],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // 1. IME composing: pass through all keys
      if (handle.isComposingRef.current) return;

      // 2. Popover open: delegate to parent
      // Read popover from store imperatively to avoid stale closure
      const currentPopover = getPromptEditorScopeState(
        usePromptEditorStore.getState(),
        handle.scopeId,
      ).popover;
      if (currentPopover && onPopoverKeyDown) {
        const handled = onPopoverKeyDown(e);
        if (handled) {
          e.preventDefault();
          return;
        }
      }

      // 3. Cmd/Ctrl+Enter: submit
      if (e.key === "Enter") {
        const onMac = isMacLikePlatform();
        const hasModifier = onMac ? e.metaKey : e.ctrlKey;
        if (hasModifier && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          onSubmit();
          return;
        }
        // Shift+Enter or bare Enter: allow default (newline)
      }

      // Backspace, other keys: default behavior
    },
    [handle, onSubmit, onPopoverKeyDown],
  );

  const activePlaceholder =
    dropActive && dropPlaceholder ? dropPlaceholder : placeholder;

  return (
    <div className="relative">
      {isEmpty && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-0 top-0 select-none text-sm leading-relaxed",
            dropActive && dropPlaceholder
              ? "text-primary"
              : "text-muted-foreground",
          )}
        >
          {activePlaceholder}
        </div>
      )}
      <div
        ref={setEditorNode}
        contentEditable={disabled ? false : "plaintext-only"}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={activePlaceholder}
        aria-disabled={disabled}
        suppressContentEditableWarning
        data-prompt-editor-drop="true"
        className={cn(
          "relative max-h-48 min-h-[24px] w-full resize-none border-none bg-transparent p-0 text-sm leading-relaxed shadow-none outline-none",
          "[&_[data-type=file]]:inline-flex [&_[data-type=file]]:items-center [&_[data-type=file]]:rounded [&_[data-type=file]]:bg-blue-50 [&_[data-type=file]]:px-1 [&_[data-type=file]]:text-blue-600 [&_[data-type=file]]:dark:bg-blue-950 [&_[data-type=file]]:dark:text-blue-400",
          "[&_[data-type=session]]:inline-flex [&_[data-type=session]]:items-center [&_[data-type=session]]:rounded [&_[data-type=session]]:bg-blue-50 [&_[data-type=session]]:px-1 [&_[data-type=session]]:text-blue-600 [&_[data-type=session]]:dark:bg-blue-950 [&_[data-type=session]]:dark:text-blue-400",
          "[&_[data-type=skill]]:inline-flex [&_[data-type=skill]]:items-center [&_[data-type=skill]]:rounded [&_[data-type=skill]]:bg-emerald-50 [&_[data-type=skill]]:px-1 [&_[data-type=skill]]:text-emerald-700 [&_[data-type=skill]]:dark:bg-emerald-950 [&_[data-type=skill]]:dark:text-emerald-300",
          "overflow-y-auto whitespace-pre-wrap break-words",
          "transition-shadow",
          "data-[prompt-editor-drop-active=true]:ring-2 data-[prompt-editor-drop-active=true]:ring-primary/60 data-[prompt-editor-drop-active=true]:ring-offset-2 data-[prompt-editor-drop-active=true]:ring-offset-background",
          disabled && "cursor-not-allowed opacity-50",
        )}
        onInput={handle.handleInput}
        onKeyDown={handleKeyDown}
        onFocus={handle.activate}
        onCompositionStart={handle.handleCompositionStart}
        onCompositionEnd={handle.handleCompositionEnd}
        onDrop={onDrop}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
      />
    </div>
  );
}
