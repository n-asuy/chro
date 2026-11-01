import {
  history,
  historyKeymap,
  indentWithTab,
  standardKeymap,
} from "@codemirror/commands";
import {
  MergeView,
  getOriginalDoc,
  unifiedMergeView,
  updateOriginalDoc,
} from "@codemirror/merge";
import { highlightSelectionMatches } from "@codemirror/search";
import {
  ChangeSet,
  EditorState,
  type Extension,
  Text,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { minimalChange } from "../codemirror/utility/minimal-change";

export type MergeDiffLayout = "split" | "unified";

export type MergeDiffViewOptions = {
  parent: HTMLElement;
  /** The file before the change. Never edited here. */
  original: string;
  /** The working text, shown on the right (split) or as the document (unified). */
  text: string;
  layout: MergeDiffLayout;
  /** Whether the working text can be edited and written back. */
  editable: boolean;
  dark: boolean;
  /** User edits of the working text, including reverted blocks. */
  onEdit?: (text: string) => void;
  /** Mod-S inside the editor. */
  onSave?: () => void;
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
};

export type MergeDiffView = {
  /** The editor holding the working text. */
  editor: EditorView;
  text: () => string;
  original: () => string;
  /** Show text read from disk without reporting it as an edit. */
  replaceText: (text: string) => void;
  /** Compare against a new base (e.g. after a commit moved it). */
  replaceOriginal: (original: string) => void;
  destroy: () => void;
};

/** Unchanged runs longer than this collapse to a "N unchanged lines" bar. */
const COLLAPSE_UNCHANGED = { margin: 4, minSize: 6 };

/** Edits inside a merge view are diffed per keystroke; keep that bounded. */
const DIFF_TIMEOUT_MS = 200;

const SVG_NS = "http://www.w3.org/2000/svg";

/** The "undo" glyph used for reverting one changed block. */
const revertIcon = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries({
    viewBox: "0 0 24 24",
    width: "14",
    height: "14",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
};

const revertButton = (onMouseDown?: (event: MouseEvent) => void) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cm-merge-revert-button";
  button.title = "Revert this change";
  button.setAttribute("aria-label", "Revert this change");
  button.appendChild(revertIcon());
  if (onMouseDown) button.addEventListener("mousedown", onMouseDown);
  return button;
};

/**
 * Prose diff styling: the document font with wrapped lines, quiet line
 * numbers, tinted changed lines and word-level highlights.
 */
const mergeDiffTheme = (options: MergeDiffViewOptions): Extension => {
  const lineHeight = options.lineHeight ?? 1.6;
  // Line numbers use a smaller font; a fixed line box keeps them on the
  // baseline of the first text line instead of floating to its top.
  const lineBox = options.fontSize
    ? `${options.fontSize * lineHeight}px`
    : String(lineHeight);
  return EditorView.theme(
    {
      "&": {
        backgroundColor: "transparent",
        color: "rgb(var(--color-text-100))",
      },
      "&.cm-focused": { outline: "none" },
      ".cm-content": {
        fontFamily: options.fontFamily ?? "inherit",
        fontSize: options.fontSize ? `${options.fontSize}px` : "inherit",
        lineHeight: lineBox,
        padding: "8px 0",
        caretColor: "rgb(var(--color-text-100))",
      },
      ".cm-line": { padding: "0 16px 0 8px" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "rgb(var(--color-text-400))",
        fontFamily: options.fontFamily ?? "inherit",
        fontSize: options.fontSize ? `${options.fontSize - 3}px` : "inherit",
      },
      ".cm-gutter": { lineHeight: lineBox },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 4px 0 12px",
        minWidth: "32px",
      },
      ".cm-deletedLine .cm-changedText, .cm-deletedChunk .cm-deletedText": {
        backgroundColor: "#ee443330",
      },
      ".cm-insertedLine .cm-changedText": {
        backgroundColor: "#22bb2230",
      },
      ".cm-collapsedLines": {
        margin: "4px 8px",
        padding: "2px 8px",
        borderRadius: "6px",
        background: "rgb(var(--color-background-90))",
        color: "rgb(var(--color-primary-100))",
        fontFamily: "inherit",
        fontSize: "12px",
      },
      ".cm-collapsedLines:hover": {
        background: "rgb(var(--color-background-80))",
      },
      ".cm-merge-revert-button, .cm-chunkButtons button": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "22px",
        height: "22px",
        padding: "0",
        border: "none",
        borderRadius: "4px",
        background: "transparent",
        color: "rgb(var(--color-text-300))",
        cursor: "pointer",
      },
      ".cm-merge-revert-button:hover, .cm-chunkButtons button:hover": {
        background: "rgb(var(--color-background-80))",
        color: "rgb(var(--color-text-100))",
      },
    },
    { dark: options.dark },
  );
};

const baseExtensions = (options: MergeDiffViewOptions): Extension[] => [
  lineNumbers(),
  highlightSelectionMatches(),
  drawSelection(),
  history(),
  keymap.of([
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        options.onSave?.();
        return true;
      },
    },
    ...standardKeymap,
    ...historyKeymap,
    indentWithTab,
  ]),
  EditorView.lineWrapping,
  mergeDiffTheme(options),
];

const readOnly: Extension = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];

/** Reports user changes; text pushed from disk is annotated as remote. */
const editListener = (onEdit: (text: string) => void): Extension =>
  EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    if (update.transactions.some((tr) => tr.annotation(Transaction.remote))) {
      return;
    }
    onEdit(update.state.doc.toString());
  });

const replaceWhole = (view: EditorView, text: string, remote: boolean) => {
  const change = minimalChange(view.state.doc.toString(), text);
  if (!change) return;
  view.dispatch({
    changes: change,
    annotations: remote ? Transaction.remote.of(true) : [],
  });
};

/**
 * A diff of a text file that edits the file itself: the working text is a
 * real editor (wrapped, with undo), unchanged runs collapse, and each changed
 * block can be reverted to the original. Split shows the original beside the
 * working text; unified shows deleted lines inline above their replacement.
 */
export const createMergeDiffView = (
  options: MergeDiffViewOptions,
): MergeDiffView => {
  const { editable, onEdit } = options;
  const working: Extension[] = [
    ...baseExtensions(options),
    editable ? (onEdit ? editListener(onEdit) : []) : readOnly,
  ];

  if (options.layout === "split") {
    const merge = new MergeView({
      parent: options.parent,
      a: {
        doc: options.original,
        extensions: [...baseExtensions(options), readOnly],
      },
      b: { doc: options.text, extensions: working },
      collapseUnchanged: COLLAPSE_UNCHANGED,
      diffConfig: { timeout: DIFF_TIMEOUT_MS },
      ...(editable
        ? {
            revertControls: "a-to-b" as const,
            renderRevertControl: () => revertButton(),
          }
        : {}),
    });
    return {
      editor: merge.b,
      text: () => merge.b.state.doc.toString(),
      original: () => merge.a.state.doc.toString(),
      replaceText: (text) => replaceWhole(merge.b, text, true),
      replaceOriginal: (original) => replaceWhole(merge.a, original, true),
      destroy: () => merge.destroy(),
    };
  }

  const editor = new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        ...working,
        unifiedMergeView({
          original: options.original,
          gutter: true,
          highlightChanges: true,
          syntaxHighlightDeletions: false,
          collapseUnchanged: COLLAPSE_UNCHANGED,
          diffConfig: { timeout: DIFF_TIMEOUT_MS },
          // The working text is the file; only "back to the original" is a
          // meaningful action on a block.
          mergeControls: editable
            ? (type, action) =>
                type === "reject"
                  ? revertButton(action)
                  : document.createElement("span")
            : false,
        }),
      ],
    }),
  });
  const currentOriginal = () => getOriginalDoc(editor.state).toString();
  return {
    editor,
    text: () => editor.state.doc.toString(),
    original: currentOriginal,
    replaceText: (text) => replaceWhole(editor, text, true),
    replaceOriginal: (original) => {
      const before = currentOriginal();
      const change = minimalChange(before, original);
      if (!change) return;
      editor.dispatch({
        effects: updateOriginalDoc.of({
          doc: Text.of(original.split("\n")),
          changes: ChangeSet.of(change, before.length),
        }),
      });
    },
    destroy: () => editor.destroy(),
  };
};
