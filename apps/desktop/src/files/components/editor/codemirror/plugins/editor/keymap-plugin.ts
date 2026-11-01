/**
 * Markdown editing keys: list and quote continuation, indentation, inline
 * formatting, and auto-paired markup.
 */

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  cursorLineBoundaryBackward,
  selectLineBoundaryBackward,
} from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
} from "@codemirror/state";
import { EditorView, type KeyBinding, keymap } from "@codemirror/view";
import {
  deleteParagraph,
  insertMarkdownLink,
  toggleBold,
  toggleChecklist,
  toggleComment,
  toggleHighlight,
  toggleItalic,
  toggleStrikethrough,
} from "./markdown-formatting";
import {
  continueMarkup,
  continueMarkupSoft,
  indentListLess,
  indentListMore,
  lineStartAfterMarkup,
} from "./markdown-lists";

/** Home stops after list and quote markup before reaching the line start. */
const lineStart =
  (extend: boolean) =>
  (view: EditorView): boolean => {
    const { state } = view;
    const targets = state.selection.ranges.map((range) =>
      lineStartAfterMarkup(state, range.head),
    );
    if (targets.every((target) => target === null)) {
      return extend
        ? selectLineBoundaryBackward(view)
        : cursorLineBoundaryBackward(view);
    }
    view.dispatch({
      selection: EditorSelection.create(
        state.selection.ranges.map((range, i) => {
          const target = targets[i] ?? state.doc.lineAt(range.head).from;
          return extend
            ? EditorSelection.range(range.anchor, target)
            : EditorSelection.cursor(target);
        }),
        state.selection.mainIndex,
      ),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };

const markdownKeys: KeyBinding[] = [
  { key: "Enter", run: continueMarkup, shift: continueMarkupSoft },
  { key: "Tab", run: indentListMore, shift: indentListLess },
  { key: "Mod-]", run: indentListMore },
  { key: "Mod-[", run: indentListLess },
  { key: "Home", run: lineStart(false), shift: lineStart(true) },
  { mac: "Mod-ArrowLeft", run: lineStart(false), shift: lineStart(true) },
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-Shift-x", run: toggleStrikethrough },
  { key: "Mod-Shift-h", run: toggleHighlight },
  { key: "Mod-/", run: toggleComment },
  { key: "Mod-k", run: insertMarkdownLink },
  { key: "Mod-l", run: toggleChecklist },
  { key: "Mod-d", run: deleteParagraph },
  { key: "Mod-Shift-k", run: deleteParagraph },
];

/**
 * Characters that pair when typed before whitespace (or wrap a selection):
 * brackets, quotes, and emphasis and code marks.
 */
const PAIRED = ["(", "[", "{", "'", '"', "`", "*", "_"];

/** Marks that only wrap a selection; typed alone they stay single. */
const WRAP_ONLY = new Set(["=", "~"]);

const wrapSelection = EditorView.inputHandler.of((view, _from, _to, text) => {
  const { state } = view;
  if (!WRAP_ONLY.has(text) || state.selection.ranges.some((r) => r.empty)) {
    return false;
  }
  view.dispatch(
    state.changeByRange((range) => ({
      changes: [
        { from: range.from, insert: text },
        { from: range.to, insert: text },
      ],
      range: EditorSelection.range(range.anchor + 1, range.head + 1),
    })),
    { scrollIntoView: true, userEvent: "input.type" },
  );
  return true;
});

/** The third backtick at the start of a line opens a fenced code block. */
const completeCodeFence = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if (text !== "`" || from !== to || state.selection.ranges.length > 1) {
    return false;
  }
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const prefix = /^((?:[ \t]*>[ \t]?)*[ \t]*)``$/.exec(before)?.[1];
  if (prefix === undefined || from !== line.to) return false;
  view.dispatch({
    changes: { from, insert: `\`\n${prefix}\`\`\`` },
    selection: EditorSelection.cursor(from + 1),
    scrollIntoView: true,
    userEvent: "input.type",
  });
  return true;
});

export const keymapPlugin: Extension = [
  Prec.high(keymap.of([...closeBracketsKeymap, ...markdownKeys])),
  Prec.high([completeCodeFence, wrapSelection]),
  closeBrackets(),
  EditorState.languageData.of(() => [{ closeBrackets: { brackets: PAIRED } }]),
];
