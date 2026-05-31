import { useMemo } from "react";
import {
  type PromptEditorHandle,
  getActivePromptEditorHandle,
  getPromptEditorHandle,
  getPromptEditorScopeState,
  usePromptEditorStore,
} from "../state/prompt-editor-store";
import type {
  ContextEntry,
  Prompt,
  SkillEntry,
  TextPart,
} from "../types/context";

// Re-export parseFromDOM for tests
export { parseFromDOM } from "../state/prompt-editor-store";

export interface UsePromptEditorResult {
  editorRef: React.RefObject<HTMLDivElement | null>;
  prompt: Prompt;
  rawText: string;
  isEmpty: boolean;
  hasText: boolean;
  popover: "at" | "skill" | null;
  atQuery: string;
  skillQuery: string;
  setPopover: (v: "at" | "skill" | null) => void;
  addFilePart: (path: string, isFile: boolean) => void;
  addSessionPart: (taskId: string, branch?: string | null) => void;
  addSkillPart: (id: string, name: string) => void;
  getText: () => string;
  getContextEntries: () => ContextEntry[];
  getSkillEntries: () => SkillEntry[];
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
export function usePromptEditor(scopeId?: string): UsePromptEditorResult {
  const handle = usePromptEditorHandle(scopeId);
  const resolvedScopeId = handle.scopeId;

  const { prompt, isEmpty, hasText, popover, atQuery, skillQuery } =
    usePromptEditorStore((state) =>
      getPromptEditorScopeState(state, resolvedScopeId),
    );
  const setPopover = usePromptEditorStore((state) => state.setPopover);

  const rawText = useMemo(() => {
    return prompt
      .filter((p): p is TextPart => p.type === "text")
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
    skillQuery,
    setPopover: (value) => setPopover(resolvedScopeId, value),
    addFilePart: handle.addFilePart,
    addSessionPart: handle.addSessionPart,
    addSkillPart: handle.addSkillPart,
    getText: handle.getText,
    getContextEntries: handle.getContextEntries,
    getSkillEntries: handle.getSkillEntries,
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
 * Returns a scoped handle object that NEVER causes re-renders on prompt changes.
 * Methods read store state imperatively via getState().
 */
export function usePromptEditorHandle(scopeId?: string): PromptEditorHandle {
  return useMemo(
    () =>
      scopeId ? getPromptEditorHandle(scopeId) : getActivePromptEditorHandle(),
    [scopeId],
  );
}
