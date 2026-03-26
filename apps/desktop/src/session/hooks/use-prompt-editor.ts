import { useMemo } from "react";
import type { ContextEntry, Prompt } from "../types/context";
import {
  getPromptEditorHandle,
  usePromptEditorStore,
  type PromptEditorHandle,
} from "../state/prompt-editor-store";

// Re-export parseFromDOM for tests
export { parseFromDOM } from "../state/prompt-editor-store";

export interface UsePromptEditorResult {
  editorRef: React.RefObject<HTMLDivElement | null>;
  prompt: Prompt;
  rawText: string;
  isEmpty: boolean;
  hasText: boolean;
  popover: "at" | null;
  atQuery: string;
  setPopover: (v: "at" | null) => void;
  addFilePart: (path: string, isFile: boolean) => void;
  getText: () => string;
  getContextEntries: () => ContextEntry[];
  isComposing: () => boolean;
  clear: () => void;
  focus: () => void;
  handleInput: () => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
}

/**
 * Full-subscribing hook — use ONLY in components that need to re-render
 * on every prompt change (e.g. the PromptEditor wrapper).
 *
 * Parent components should use usePromptEditorHandle() instead.
 */
export function usePromptEditor(): UsePromptEditorResult {
  const handle = getPromptEditorHandle();

  const { prompt, isEmpty, hasText, popover, atQuery, setPopover } =
    usePromptEditorStore();

  const rawText = useMemo(() => {
    return prompt
      .filter((p): p is { type: "text"; content: string } => p.type === "text")
      .map((p) => p.content)
      .join("");
  }, [prompt]);

  return {
    editorRef: handle.editorRef,
    prompt,
    rawText,
    isEmpty,
    hasText,
    popover,
    atQuery,
    setPopover,
    addFilePart: handle.addFilePart,
    getText: handle.getText,
    getContextEntries: handle.getContextEntries,
    isComposing: () => handle.isComposingRef.current,
    clear: handle.clear,
    focus: handle.focus,
    handleInput: handle.handleInput,
    handleCompositionStart: handle.handleCompositionStart,
    handleCompositionEnd: handle.handleCompositionEnd,
  };
}

/**
 * Non-reactive handle hook — use in parent components.
 * Returns the singleton handle object that NEVER causes re-renders on prompt changes.
 * Methods read store state imperatively via getState().
 */
export function usePromptEditorHandle(): PromptEditorHandle {
  return getPromptEditorHandle();
}
