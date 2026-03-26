import { useCallback } from "react";
import { cn } from "@chro/ui/utils";
import type { PromptEditorHandle } from "../../state/prompt-editor-store";
import { usePromptEditorStore } from "../../state/prompt-editor-store";

interface PromptEditorProps {
  handle: PromptEditorHandle;
  disabled?: boolean;
  placeholder?: string;
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
  onSubmit,
  onPopoverKeyDown,
  onDrop,
  onPaste,
}: PromptEditorProps) {
  // Subscribe only to popover (not the whole store)
  const popover = usePromptEditorStore((s) => s.popover);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // 1. IME composing: pass through all keys
      if (handle.isComposingRef.current) return;

      // 2. Popover open: delegate to parent
      // Read popover from store imperatively to avoid stale closure
      const currentPopover = usePromptEditorStore.getState().popover;
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

  return (
    <div
      ref={handle.editorRef}
      contentEditable={disabled ? false : "plaintext-only"}
      role="textbox"
      aria-multiline="true"
      aria-placeholder={placeholder}
      aria-disabled={disabled}
      suppressContentEditableWarning
      className={cn(
        "max-h-48 min-h-[56px] w-full resize-none border-none bg-transparent p-0 text-sm leading-relaxed shadow-none outline-none",
        "empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(aria-placeholder)]",
        "[&_[data-type=file]]:inline-flex [&_[data-type=file]]:items-center [&_[data-type=file]]:rounded [&_[data-type=file]]:bg-blue-50 [&_[data-type=file]]:px-1 [&_[data-type=file]]:text-blue-600 [&_[data-type=file]]:dark:bg-blue-950 [&_[data-type=file]]:dark:text-blue-400",
        "overflow-y-auto whitespace-pre-wrap break-words",
        disabled && "cursor-not-allowed opacity-50",
      )}
      onInput={handle.handleInput}
      onKeyDown={handleKeyDown}
      onCompositionStart={handle.handleCompositionStart}
      onCompositionEnd={handle.handleCompositionEnd}
      onDrop={onDrop}
      onPaste={onPaste}
      onDragOver={(e) => e.preventDefault()}
    />
  );
}
