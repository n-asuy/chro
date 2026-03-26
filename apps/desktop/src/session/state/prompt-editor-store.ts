import { create } from "zustand";
import type {
  ContentPart,
  ContextEntry,
  FileAttachmentPart,
  Prompt,
  TextPart,
} from "../types/context";
import {
  DEFAULT_PROMPT,
  extractSessionId,
  getContextEntries,
} from "../types/context";

const ZERO_WIDTH_SPACE = "\u200B";

/**
 * Recursively parse contenteditable DOM into ContentPart array.
 * Exported for testing.
 */
export function parseFromDOM(root: HTMLElement): Prompt {
  const parts: ContentPart[] = [];
  let buffer = "";
  let offset = 0;

  const flush = () => {
    if (buffer.length > 0) {
      const cleaned = buffer.replaceAll(ZERO_WIDTH_SPACE, "");
      parts.push({
        type: "text",
        content: cleaned,
        start: offset - buffer.length,
        end: offset,
      });
      buffer = "";
    }
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      buffer += text;
      offset += text.length;
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;

    if (el.tagName === "BR") {
      buffer += "\n";
      offset += 1;
      return;
    }

    if (el.dataset.type === "file" && el.dataset.path) {
      flush();
      const displayText = el.textContent ?? "";
      const part: FileAttachmentPart = {
        type: "file",
        content: displayText,
        path: el.dataset.path,
        isFile: el.dataset.isFile !== "false",
        start: offset,
        end: offset + displayText.length,
      };
      if (el.dataset.branch) {
        part.branch = el.dataset.branch;
      }
      parts.push(part);
      offset += displayText.length;
      return;
    }

    const isBlock =
      el.tagName === "DIV" || el.tagName === "P" || el.tagName === "BLOCKQUOTE";

    if (isBlock && offset > 0 && !buffer.endsWith("\n")) {
      buffer += "\n";
      offset += 1;
    }

    for (const child of el.childNodes) {
      walk(child);
    }

    if (isBlock && !buffer.endsWith("\n")) {
      buffer += "\n";
      offset += 1;
    }
  };

  for (const child of root.childNodes) {
    walk(child);
  }
  flush();

  if (parts.length === 0) {
    return [{ type: "text", content: "", start: 0, end: 0 }];
  }

  // Trim trailing newline from last text part (block element artifact)
  const last = parts[parts.length - 1];
  if (last.type === "text" && last.content.endsWith("\n")) {
    parts[parts.length - 1] = {
      ...last,
      content: last.content.slice(0, -1),
    };
  }

  return parts;
}

function getTextFromPrompt(prompt: Prompt): string {
  return prompt
    .filter((p): p is TextPart => p.type === "text")
    .map((p) => p.content)
    .join("");
}

function getCursorOffsetInEditor(editor: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return -1;

  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(editor);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().replaceAll(ZERO_WIDTH_SPACE, "").length;
}

type DocumentWithCaretPoint = Document & {
  caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function moveCaretToEnd(editor: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

function getSelectionInEditor(
  editor: HTMLElement,
): { selection: Selection; range: Range } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer)) {
    return null;
  }

  return { selection, range };
}

// --- Zustand store ---

interface PromptEditorState {
  prompt: Prompt;
  isEmpty: boolean;
  hasText: boolean;
  popover: "at" | null;
  atQuery: string;
}

interface PromptEditorActions {
  /** Update prompt from parsed DOM result */
  setPrompt: (prompt: Prompt) => void;
  setPopover: (v: "at" | null) => void;
  setAtQuery: (q: string) => void;
  clear: () => void;
}

type PromptEditorStore = PromptEditorState & PromptEditorActions;

function computeDerived(prompt: Prompt) {
  const rawText = getTextFromPrompt(prompt);
  const trimmed = rawText.trim();
  return {
    isEmpty: trimmed.length === 0 && !prompt.some((p) => p.type === "file"),
    hasText: trimmed.length > 0,
  };
}

export const usePromptEditorStore = create<PromptEditorStore>((set) => ({
  prompt: DEFAULT_PROMPT,
  isEmpty: true,
  hasText: false,
  popover: null,
  atQuery: "",

  setPrompt: (prompt) =>
    set({ prompt, ...computeDerived(prompt) }),

  setPopover: (popover) => set({ popover }),

  setAtQuery: (atQuery) => set({ atQuery }),

  clear: () =>
    set({
      prompt: DEFAULT_PROMPT,
      isEmpty: true,
      hasText: false,
      popover: null,
      atQuery: "",
    }),
}));

// --- Imperative actions (no re-render on the caller) ---

/**
 * Non-reactive handle for parent components that need to call actions
 * without subscribing to prompt state changes.
 *
 * editorRef must be set by the PromptEditor component.
 */
export interface PromptEditorHandle {
  editorRef: React.MutableRefObject<HTMLDivElement | null>;
  isComposingRef: React.MutableRefObject<boolean>;
  getText: () => string;
  getContextEntries: () => ContextEntry[];
  isEmpty: () => boolean;
  /** Snapshot current content, clear DOM + store. Call restore() to undo. */
  clearWithSnapshot: () => void;
  /** Restore content from the last clearWithSnapshot(). No-op if no snapshot. */
  restore: () => void;
  clear: () => void;
  focus: () => void;
  setCursorFromPoint: (x: number, y: number) => boolean;
  handleInput: () => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  addFilePart: (
    path: string,
    isFile: boolean,
    branch?: string | null,
  ) => void;
}

let singletonHandle: PromptEditorHandle | null = null;

/**
 * Returns the singleton prompt editor handle.
 * The handle's methods read from the store imperatively (getState),
 * so calling them never triggers a re-render on the caller.
 *
 * Singleton ensures editorRef/isComposingRef are shared across all consumers.
 */
export function getPromptEditorHandle(): PromptEditorHandle {
  if (singletonHandle) return singletonHandle;

  const editorRef: React.MutableRefObject<HTMLDivElement | null> = {
    current: null,
  };
  const isComposingRef: React.MutableRefObject<boolean> = { current: false };
  let snapshotHtml: string | null = null;
  let snapshotPrompt: Prompt | null = null;

  const handle: PromptEditorHandle = {
    editorRef,
    isComposingRef,

    getText: () => {
      const { prompt } = usePromptEditorStore.getState();
      return getTextFromPrompt(prompt);
    },

    getContextEntries: () => {
      const { prompt } = usePromptEditorStore.getState();
      return getContextEntries(prompt);
    },

    isEmpty: () => {
      return usePromptEditorStore.getState().isEmpty;
    },

    clearWithSnapshot: () => {
      const el = editorRef.current;
      snapshotHtml = el ? el.innerHTML : null;
      snapshotPrompt = usePromptEditorStore.getState().prompt;
      if (el) {
        el.innerHTML = "";
      }
      usePromptEditorStore.getState().clear();
    },

    restore: () => {
      if (snapshotPrompt === null) return;
      const el = editorRef.current;
      if (el && snapshotHtml !== null) {
        el.innerHTML = snapshotHtml;
      }
      usePromptEditorStore.getState().setPrompt(snapshotPrompt);
      snapshotHtml = null;
      snapshotPrompt = null;
    },

    clear: () => {
      snapshotHtml = null;
      snapshotPrompt = null;
      const el = editorRef.current;
      if (el) {
        el.innerHTML = "";
      }
      usePromptEditorStore.getState().clear();
    },

    focus: () => {
      editorRef.current?.focus();
    },

    setCursorFromPoint: (x: number, y: number) => {
      const el = editorRef.current;
      if (!el) return false;

      el.focus();

      const doc = el.ownerDocument as DocumentWithCaretPoint;
      let range: Range | null = null;

      if (typeof doc.caretPositionFromPoint === "function") {
        const position = doc.caretPositionFromPoint(x, y);
        if (position && el.contains(position.offsetNode)) {
          range = doc.createRange();
          range.setStart(position.offsetNode, position.offset);
          range.collapse(true);
        }
      } else if (typeof doc.caretRangeFromPoint === "function") {
        const pointRange = doc.caretRangeFromPoint(x, y);
        if (pointRange && el.contains(pointRange.startContainer)) {
          range = pointRange;
          range.collapse(true);
        }
      }

      if (!range) {
        return moveCaretToEnd(el);
      }

      const selection = window.getSelection();
      if (!selection) return false;
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    },

    handleInput: () => {
      const el = editorRef.current;
      if (!el) return;

      const parsed = parseFromDOM(el);
      const store = usePromptEditorStore.getState();
      store.setPrompt(parsed);

      // Detect @ trigger
      const cursorPos = getCursorOffsetInEditor(el);
      if (cursorPos >= 0) {
        const textBefore = getTextFromPrompt(parsed).substring(0, cursorPos);
        const atMatch = textBefore.match(/@(\S*)$/);
        if (atMatch) {
          store.setAtQuery(atMatch[1]);
          store.setPopover("at");
        } else {
          store.setPopover(null);
        }
      }
    },

    handleCompositionStart: () => {
      isComposingRef.current = true;
    },

    handleCompositionEnd: () => {
      isComposingRef.current = false;
    },

    addFilePart: (path: string, isFile: boolean, branch?: string | null) => {
      const el = editorRef.current;
      if (!el) return;

      el.focus();

      let selectionState = getSelectionInEditor(el);
      if (!selectionState) {
        if (!moveCaretToEnd(el)) return;
        selectionState = getSelectionInEditor(el);
      }
      if (!selectionState) return;

      const { selection: sel } = selectionState;

      // Find and remove @query text before cursor
      const range = sel.getRangeAt(0);
      const textNode = range.startContainer;
      if (textNode.nodeType === Node.TEXT_NODE) {
        const text = textNode.textContent ?? "";
        const cursorOffset = range.startOffset;
        const beforeCursor = text.substring(0, cursorOffset);
        const atIdx = beforeCursor.lastIndexOf("@");
        if (atIdx !== -1) {
          const deleteRange = document.createRange();
          deleteRange.setStart(textNode, atIdx);
          deleteRange.setEnd(textNode, cursorOffset);
          deleteRange.deleteContents();
        }
      }

      // Create pill element
      const sessionId = extractSessionId(path);
      const displayName = sessionId
        ? sessionId
        : path.split("/").pop() ?? path;
      const pill = document.createElement("span");
      pill.dataset.type = "file";
      pill.dataset.path = path;
      pill.dataset.isFile = String(isFile);
      if (branch) {
        pill.dataset.branch = branch;
      }
      pill.contentEditable = "false";
      pill.textContent = `@${displayName}`;

      // Insert pill at current cursor
      const insertRange = sel.getRangeAt(0);
      insertRange.collapse(false);
      insertRange.insertNode(pill);

      // Add space after pill
      const space = document.createTextNode(" ");
      pill.after(space);

      // Move cursor after space
      const newRange = document.createRange();
      newRange.setStartAfter(space);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      // Close popover and reparse
      const store = usePromptEditorStore.getState();
      store.setPopover(null);
      store.setAtQuery("");
      const parsed = parseFromDOM(el);
      store.setPrompt(parsed);
    },
  };

  singletonHandle = handle;
  return handle;
}
