import { create } from "zustand";
import type {
  ContentPart,
  ContextEntry,
  FileAttachmentPart,
  Prompt,
  SessionAttachmentPart,
  SkillAttachmentPart,
  SkillEntry,
  TextPart,
} from "../types/context";
import {
  DEFAULT_PROMPT,
  getContextEntries,
  getSkillEntries,
  shortSessionId,
} from "../types/context";

const ZERO_WIDTH_SPACE = "\u200B";
const DEFAULT_PROMPT_SCOPE_ID = "default";

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

    if (el.dataset.type === "session" && el.dataset.taskId) {
      flush();
      const displayText = el.textContent ?? "";
      const part: SessionAttachmentPart = {
        type: "session",
        content: displayText,
        taskId: el.dataset.taskId,
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

    if (el.dataset.type === "skill" && el.dataset.skillId) {
      flush();
      const displayText = el.textContent ?? "";
      const part: SkillAttachmentPart = {
        type: "skill",
        content: displayText,
        id: el.dataset.skillId,
        name: el.dataset.skillName ?? displayText.replace(/^#/, ""),
        start: offset,
        end: offset + displayText.length,
      };
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

function createEmptyPrompt(): Prompt {
  return DEFAULT_PROMPT.map((part) => ({ ...part }));
}

function promptDisplayContent(part: ContentPart): string {
  switch (part.type) {
    case "file":
    case "session":
      return (
        part.content ||
        `@${part.type === "file" ? part.path : shortSessionId(part.taskId)}`
      );
    case "skill":
      return part.content || `#${part.name}`;
    case "text":
      return part.content;
  }
}

function createAttachmentPill(
  part: Exclude<ContentPart, TextPart>,
): HTMLElement {
  const pill = document.createElement("span");
  pill.contentEditable = "false";
  pill.textContent = promptDisplayContent(part);

  switch (part.type) {
    case "file":
      pill.dataset.type = "file";
      pill.dataset.path = part.path;
      pill.dataset.isFile = String(part.isFile);
      if (part.branch) pill.dataset.branch = part.branch;
      break;
    case "session":
      pill.dataset.type = "session";
      pill.dataset.taskId = part.taskId;
      if (part.branch) pill.dataset.branch = part.branch;
      break;
    case "skill":
      pill.dataset.type = "skill";
      pill.dataset.skillId = part.id;
      pill.dataset.skillName = part.name;
      break;
  }

  return pill;
}

function renderPromptIntoDOM(editor: HTMLElement, prompt: Prompt) {
  editor.replaceChildren();
  for (const part of prompt) {
    if (part.type === "text") {
      if (part.content.length > 0) {
        editor.append(document.createTextNode(part.content));
      }
      continue;
    }
    editor.append(createAttachmentPill(part));
  }
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

/**
 * Drop an inline pill into the editor at the cursor, mirroring the contract
 * used by file, session, and skill attachments.
 */
function insertPill(
  scopeId: string,
  editor: HTMLElement | null,
  dataset: Record<string, string>,
  displayName: string,
  options: { trigger?: "at" | "skill"; prefix?: string } = {},
) {
  if (!editor) return;
  editor.focus({ preventScroll: true });

  let selectionState = getSelectionInEditor(editor);
  if (!selectionState) {
    if (!moveCaretToEnd(editor)) return;
    selectionState = getSelectionInEditor(editor);
  }
  if (!selectionState) return;

  const { selection: sel } = selectionState;

  const range = sel.getRangeAt(0);
  if (options.trigger === "skill") {
    // Skills can be triggered by "/" (slash mention), "@" (context menu),
    // or the "+" menu (no trigger). Delete whichever trigger is present.
    if (!deleteSkillTriggerBeforeCursor(range)) {
      deleteTriggerBeforeCursor(range, ["@"]);
    }
  } else {
    deleteTriggerBeforeCursor(range, ["@"]);
  }

  const pill = document.createElement("span");
  for (const [key, value] of Object.entries(dataset)) {
    pill.dataset[key] = value;
  }
  pill.contentEditable = "false";
  pill.textContent = `${options.prefix ?? "@"}${displayName}`;

  const insertRange = sel.getRangeAt(0);
  insertRange.collapse(false);
  insertRange.insertNode(pill);

  const space = document.createTextNode(" ");
  pill.after(space);

  const newRange = document.createRange();
  newRange.setStartAfter(space);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);

  const store = usePromptEditorStore.getState();
  store.setPopover(scopeId, null);
  if (options.trigger === "skill") {
    store.setSkillQuery(scopeId, "");
  } else {
    store.setAtQuery(scopeId, "");
  }
  const parsed = parseFromDOM(editor);
  store.setPrompt(scopeId, parsed);
}

// --- Zustand store ---

interface PromptEditorScopeState {
  prompt: Prompt;
  isEmpty: boolean;
  hasText: boolean;
  popover: "at" | "skill" | null;
  atQuery: string;
  skillQuery: string;
}

interface PromptEditorActions {
  /** Update prompt from parsed DOM result */
  setPrompt: (scopeId: string, prompt: Prompt) => void;
  setPopover: (scopeId: string, v: "at" | "skill" | null) => void;
  setAtQuery: (scopeId: string, q: string) => void;
  setSkillQuery: (scopeId: string, q: string) => void;
  clear: (scopeId: string) => void;
}

type PromptEditorStore = {
  scopes: Record<string, PromptEditorScopeState>;
} & PromptEditorActions;

const EMPTY_SCOPE_STATE: PromptEditorScopeState = {
  prompt: DEFAULT_PROMPT,
  isEmpty: true,
  hasText: false,
  popover: null,
  atQuery: "",
  skillQuery: "",
};

function createEmptyScopeState(): PromptEditorScopeState {
  return {
    ...EMPTY_SCOPE_STATE,
    prompt: createEmptyPrompt(),
  };
}

export function getPromptEditorScopeState(
  state: PromptEditorStore,
  scopeId: string,
): PromptEditorScopeState {
  return state.scopes[scopeId] ?? EMPTY_SCOPE_STATE;
}

function updateScope(
  current: Record<string, PromptEditorScopeState>,
  scopeId: string,
  patch: Partial<PromptEditorScopeState>,
): Record<string, PromptEditorScopeState> {
  const previous = current[scopeId] ?? createEmptyScopeState();
  return {
    ...current,
    [scopeId]: {
      ...previous,
      ...patch,
    },
  };
}

function computeDerived(prompt: Prompt) {
  const rawText = getTextFromPrompt(prompt);
  const trimmed = rawText.trim();
  const hasAttachments = prompt.some((p) => p.type !== "text");
  return {
    isEmpty: trimmed.length === 0 && !hasAttachments,
    hasText: trimmed.length > 0,
  };
}

export const usePromptEditorStore = create<PromptEditorStore>((set) => ({
  scopes: {},

  setPrompt: (scopeId, prompt) =>
    set((state) => ({
      scopes: updateScope(state.scopes, scopeId, {
        prompt,
        ...computeDerived(prompt),
      }),
    })),

  setPopover: (scopeId, popover) =>
    set((state) => ({
      scopes: updateScope(state.scopes, scopeId, { popover }),
    })),

  setAtQuery: (scopeId, atQuery) =>
    set((state) => ({
      scopes: updateScope(state.scopes, scopeId, { atQuery }),
    })),

  setSkillQuery: (scopeId, skillQuery) =>
    set((state) => ({
      scopes: updateScope(state.scopes, scopeId, { skillQuery }),
    })),

  clear: (scopeId) =>
    set((state) => ({
      scopes: {
        ...state.scopes,
        [scopeId]: createEmptyScopeState(),
      },
    })),
}));

function getSkillTriggerQuery(textBeforeCursor: string): string | null {
  const lineStart = textBeforeCursor.lastIndexOf("\n") + 1;
  const currentLine = textBeforeCursor.slice(lineStart);
  if (!currentLine.startsWith("/")) {
    return null;
  }
  const raw = currentLine.slice(1);
  if (/\s/.test(raw)) {
    return null;
  }
  return raw;
}

function deleteTriggerBeforeCursor(
  range: Range,
  triggerChars: string[],
): boolean {
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) {
    return false;
  }

  const text = textNode.textContent ?? "";
  const cursorOffset = range.startOffset;
  const beforeCursor = text.substring(0, cursorOffset);
  let triggerIdx = -1;
  for (const trigger of triggerChars) {
    triggerIdx = Math.max(triggerIdx, beforeCursor.lastIndexOf(trigger));
  }
  if (triggerIdx === -1) {
    return false;
  }

  const deleteRange = document.createRange();
  deleteRange.setStart(textNode, triggerIdx);
  deleteRange.setEnd(textNode, cursorOffset);
  deleteRange.deleteContents();
  return true;
}

function deleteSkillTriggerBeforeCursor(range: Range): boolean {
  const textNode = range.startContainer;
  if (textNode.nodeType !== Node.TEXT_NODE) {
    return false;
  }

  const text = textNode.textContent ?? "";
  const cursorOffset = range.startOffset;
  const beforeCursor = text.substring(0, cursorOffset);
  const lineStart = beforeCursor.lastIndexOf("\n") + 1;
  if (!beforeCursor.slice(lineStart).startsWith("/")) {
    return false;
  }

  const deleteRange = document.createRange();
  deleteRange.setStart(textNode, lineStart);
  deleteRange.setEnd(textNode, cursorOffset);
  deleteRange.deleteContents();
  return true;
}

// --- Imperative actions (no re-render on the caller) ---

/**
 * Non-reactive handle for parent components that need to call actions
 * without subscribing to prompt state changes.
 *
 * editorRef must be set by the PromptEditor component.
 */
export interface PromptEditorHandle {
  scopeId: string;
  editorRef: React.MutableRefObject<HTMLDivElement | null>;
  isComposingRef: React.MutableRefObject<boolean>;
  getText: () => string;
  getContextEntries: () => ContextEntry[];
  getSkillEntries: () => SkillEntry[];
  isEmpty: () => boolean;
  /** Snapshot current content, clear DOM + store. Call restore() to undo. */
  clearWithSnapshot: () => void;
  /** Restore content from the last clearWithSnapshot(). No-op if no snapshot. */
  restore: () => void;
  clear: () => void;
  focus: () => void;
  activate: () => void;
  syncDomFromStore: () => void;
  setCursorFromPoint: (x: number, y: number) => boolean;
  handleInput: () => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  addFilePart: (path: string, isFile: boolean, branch?: string | null) => void;
  addSessionPart: (taskId: string, branch?: string | null) => void;
  addSkillPart: (id: string, name: string) => void;
}

const handlesByScope = new Map<string, PromptEditorHandle>();
let activeScopeId: string | null = null;
let activeProxyHandle: PromptEditorHandle | null = null;

function getScopePrompt(scopeId: string): Prompt {
  return getPromptEditorScopeState(usePromptEditorStore.getState(), scopeId)
    .prompt;
}

function setActiveScope(scopeId: string) {
  activeScopeId = scopeId;
}

/**
 * Returns a prompt editor handle scoped to one tab/session surface.
 * The handle's methods read from the store imperatively (getState),
 * so calling them never triggers a re-render on the caller.
 */
export function getPromptEditorHandle(
  scopeId = DEFAULT_PROMPT_SCOPE_ID,
): PromptEditorHandle {
  const existing = handlesByScope.get(scopeId);
  if (existing) return existing;
  const editorRef: React.MutableRefObject<HTMLDivElement | null> = {
    current: null,
  };
  const isComposingRef: React.MutableRefObject<boolean> = { current: false };
  let snapshotHtml: string | null = null;
  let snapshotPrompt: Prompt | null = null;

  const handle: PromptEditorHandle = {
    scopeId,
    editorRef,
    isComposingRef,

    getText: () => {
      return getTextFromPrompt(getScopePrompt(scopeId));
    },

    getContextEntries: () => {
      return getContextEntries(getScopePrompt(scopeId));
    },

    getSkillEntries: () => {
      return getSkillEntries(getScopePrompt(scopeId));
    },

    isEmpty: () => {
      return getPromptEditorScopeState(usePromptEditorStore.getState(), scopeId)
        .isEmpty;
    },

    clearWithSnapshot: () => {
      setActiveScope(scopeId);
      const el = editorRef.current;
      snapshotHtml = el ? el.innerHTML : null;
      snapshotPrompt = getScopePrompt(scopeId);
      if (el) {
        el.innerHTML = "";
      }
      usePromptEditorStore.getState().clear(scopeId);
    },

    restore: () => {
      if (snapshotPrompt === null) return;
      setActiveScope(scopeId);
      const el = editorRef.current;
      if (el && snapshotHtml !== null) {
        el.innerHTML = snapshotHtml;
      }
      usePromptEditorStore.getState().setPrompt(scopeId, snapshotPrompt);
      snapshotHtml = null;
      snapshotPrompt = null;
    },

    clear: () => {
      setActiveScope(scopeId);
      snapshotHtml = null;
      snapshotPrompt = null;
      const el = editorRef.current;
      if (el) {
        el.innerHTML = "";
      }
      usePromptEditorStore.getState().clear(scopeId);
    },

    focus: () => {
      setActiveScope(scopeId);
      editorRef.current?.focus({ preventScroll: true });
    },

    activate: () => {
      setActiveScope(scopeId);
    },

    syncDomFromStore: () => {
      const el = editorRef.current;
      if (!el) return;
      renderPromptIntoDOM(el, getScopePrompt(scopeId));
    },

    setCursorFromPoint: (x: number, y: number) => {
      setActiveScope(scopeId);
      const el = editorRef.current;
      if (!el) return false;

      el.focus({ preventScroll: true });

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
      setActiveScope(scopeId);
      const el = editorRef.current;
      if (!el) return;

      const parsed = parseFromDOM(el);
      const store = usePromptEditorStore.getState();
      store.setPrompt(scopeId, parsed);

      // Detect @ trigger
      const cursorPos = getCursorOffsetInEditor(el);
      if (cursorPos >= 0) {
        const textBefore = getTextFromPrompt(parsed).substring(0, cursorPos);
        const atMatch = textBefore.match(/@(\S*)$/);
        if (atMatch) {
          store.setAtQuery(scopeId, atMatch[1]);
          store.setPopover(scopeId, "at");
        } else {
          const skillQuery = getSkillTriggerQuery(textBefore);
          if (skillQuery !== null) {
            store.setSkillQuery(scopeId, skillQuery);
            store.setPopover(scopeId, "skill");
          } else {
            store.setPopover(scopeId, null);
          }
        }
      }
    },

    handleCompositionStart: () => {
      setActiveScope(scopeId);
      isComposingRef.current = true;
    },

    handleCompositionEnd: () => {
      isComposingRef.current = false;
    },

    addFilePart: (path: string, isFile: boolean, branch?: string | null) => {
      const displayName = path.split("/").pop() ?? path;
      const dataset: Record<string, string> = {
        type: "file",
        path,
        isFile: String(isFile),
      };
      if (branch) {
        dataset.branch = branch;
      }
      insertPill(scopeId, editorRef.current, dataset, displayName);
    },

    addSessionPart: (taskId: string, branch?: string | null) => {
      const dataset: Record<string, string> = {
        type: "session",
        taskId,
      };
      if (branch) {
        dataset.branch = branch;
      }
      insertPill(scopeId, editorRef.current, dataset, shortSessionId(taskId));
    },

    addSkillPart: (id: string, name: string) => {
      insertPill(
        scopeId,
        editorRef.current,
        {
          type: "skill",
          skillId: id,
          skillName: name,
        },
        name,
        { trigger: "skill", prefix: "#" },
      );
    },
  };

  handlesByScope.set(scopeId, handle);
  return handle;
}

function activeHandle(): PromptEditorHandle {
  if (activeScopeId) {
    const handle = handlesByScope.get(activeScopeId);
    if (handle) return handle;
  }
  return getPromptEditorHandle(DEFAULT_PROMPT_SCOPE_ID);
}

function createActiveRef<T>(
  read: (handle: PromptEditorHandle) => React.MutableRefObject<T>,
): React.MutableRefObject<T> {
  const ref = {} as React.MutableRefObject<T>;
  Object.defineProperty(ref, "current", {
    get: () => read(activeHandle()).current,
    set: (value: T) => {
      read(activeHandle()).current = value;
    },
  });
  return ref;
}

export function getActivePromptEditorHandle(): PromptEditorHandle {
  if (activeProxyHandle) return activeProxyHandle;

  const proxy: PromptEditorHandle = {
    scopeId: "__active__",
    editorRef: createActiveRef((handle) => handle.editorRef),
    isComposingRef: createActiveRef((handle) => handle.isComposingRef),
    getText: () => activeHandle().getText(),
    getContextEntries: () => activeHandle().getContextEntries(),
    getSkillEntries: () => activeHandle().getSkillEntries(),
    isEmpty: () => activeHandle().isEmpty(),
    clearWithSnapshot: () => activeHandle().clearWithSnapshot(),
    restore: () => activeHandle().restore(),
    clear: () => activeHandle().clear(),
    focus: () => activeHandle().focus(),
    activate: () => activeHandle().activate(),
    syncDomFromStore: () => activeHandle().syncDomFromStore(),
    setCursorFromPoint: (x, y) => activeHandle().setCursorFromPoint(x, y),
    handleInput: () => activeHandle().handleInput(),
    handleCompositionStart: () => activeHandle().handleCompositionStart(),
    handleCompositionEnd: () => activeHandle().handleCompositionEnd(),
    addFilePart: (path, isFile, branch) =>
      activeHandle().addFilePart(path, isFile, branch),
    addSessionPart: (taskId, branch) =>
      activeHandle().addSessionPart(taskId, branch),
    addSkillPart: (id, name) => activeHandle().addSkillPart(id, name),
  };

  activeProxyHandle = proxy;
  return proxy;
}
