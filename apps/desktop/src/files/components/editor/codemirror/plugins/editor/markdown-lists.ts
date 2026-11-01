/**
 * List and blockquote editing: what Enter, Shift-Enter, Tab and Home do on a
 * line that starts with markup. The rules work on the line text, not the
 * syntax tree, so a half-typed list behaves the same as a parsed one.
 */

import { indentLess, indentMore } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type StateCommand,
  Transaction,
} from "@codemirror/state";

/** The markup at the start of a line, split into its parts. */
export type LineMarkup = {
  /** Blockquote markers, e.g. "> > ". */
  quote: string;
  /** Whitespace between the quote and the list marker. */
  indent: string;
  /** List marker, e.g. "-", "*", "3." or "3)"; null when not a list item. */
  marker: string | null;
  /** Number of an ordered marker. */
  number: number | null;
  /** Whitespace after the marker. */
  spacing: string;
  /** Task checkbox including its trailing whitespace, e.g. "[ ] ". */
  checkbox: string;
  /** Offset where the marker starts (after quote and indent). */
  markerStart: number;
  /** Offset where the item text starts. */
  contentStart: number;
};

const LINE_MARKUP =
  /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+]|(\d{1,9})[.)])([ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?)?/;

export const parseLineMarkup = (text: string): LineMarkup => {
  const match = LINE_MARKUP.exec(text);
  const quote = match?.[1] ?? "";
  const marker = match?.[3] ?? null;
  // Without a marker, leading whitespace is part of the text.
  const indent = marker ? match?.[2] ?? "" : "";
  const spacing = match?.[5] ?? "";
  const checkbox = match?.[6] ?? "";
  const markerStart = quote.length + indent.length;
  return {
    quote,
    indent,
    marker,
    number: match?.[4] ? Number(match[4]) : null,
    spacing,
    checkbox,
    markerStart,
    contentStart:
      markerStart + (marker?.length ?? 0) + spacing.length + checkbox.length,
  };
};

// Only fenced code counts: tab-indented lines are ordinary (often list) text
// in notes, not indented code blocks.
const isInCode = (state: EditorState, pos: number): boolean => {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null =
      syntaxTree(state).resolveInner(pos, -1);
    node;
    node = node.parent
  ) {
    if (node.name === "FencedCode") return true;
  }
  return false;
};

const columnWidth = (state: EditorState, whitespace: string): number => {
  let width = 0;
  for (const char of whitespace) {
    width =
      char === "\t"
        ? width + state.tabSize - (width % state.tabSize)
        : width + 1;
  }
  return width;
};

/** Remove one indentation level (a tab or up to one tab-width of spaces). */
const outdented = (state: EditorState, indent: string): string => {
  if (indent.endsWith("\t")) return indent.slice(0, -1);
  const spaces = /( *)$/.exec(indent)?.[1].length ?? 0;
  return indent.slice(0, indent.length - Math.min(spaces, state.tabSize));
};

/** Quote markers with the innermost level removed. */
const outerQuote = (quote: string): string =>
  quote.replace(/[ \t]*>[ \t]?$/, "");

const nextMarker = (markup: LineMarkup): string => {
  const marker = markup.marker ?? "-";
  if (markup.number === null) return marker;
  return `${markup.number + 1}${marker.slice(-1)}`;
};

/**
 * Renumber ordered lists in the blocks (runs of non-blank lines) containing
 * `lines`. An item continues the count of the previous item at its level;
 * the first item of a nested list, or one just moved to a new level, starts
 * at 1, and the first item of a top-level list keeps its number.
 */
const renumberOrderedLists = (
  state: EditorState,
  lines: Iterable<number>,
  moved: ReadonlySet<number>,
): ChangeSpec[] => {
  const doc = state.doc;
  const isBlank = (n: number) => doc.line(n).text.trim() === "";
  const changes: ChangeSpec[] = [];
  const visited = new Set<number>();

  for (const start of lines) {
    if (
      start < 1 ||
      start > doc.lines ||
      visited.has(start) ||
      isBlank(start)
    ) {
      continue;
    }
    let first = start;
    while (first > 1 && !isBlank(first - 1)) first--;
    let last = start;
    while (last < doc.lines && !isBlank(last + 1)) last++;

    const levels: { width: number; last: number | null }[] = [];
    for (let n = first; n <= last; n++) {
      visited.add(n);
      const line = doc.line(n);
      const markup = parseLineMarkup(line.text);
      if (!markup.marker) continue;
      const width = columnWidth(state, markup.indent);
      while ((levels.at(-1)?.width ?? -1) > width) levels.pop();
      let level = levels.at(-1);
      if (!level || level.width !== width) {
        level = { width, last: null };
        levels.push(level);
      }
      if (markup.number === null) {
        level.last = null;
        continue;
      }
      const number =
        level.last !== null
          ? level.last + 1
          : levels.length > 1 || moved.has(n)
            ? 1
            : markup.number;
      level.last = number;
      if (number !== markup.number) {
        const from = line.from + markup.markerStart;
        const to = from + String(markup.number).length;
        changes.push({ from, to, insert: String(number) });
      }
    }
  }
  return changes;
};

/**
 * Dispatch `tr` with the ordered lists around `touched` (line numbers in its
 * resulting document) renumbered, as one undo step.
 */
const dispatchRenumbered = (
  dispatch: (tr: Transaction) => void,
  tr: Transaction,
  touched: Iterable<number>,
  moved: ReadonlySet<number> = new Set(),
): void => {
  const renumber = tr.state.changes(
    renumberOrderedLists(tr.state, touched, moved),
  );
  dispatch(
    tr.startState.update({
      changes: tr.changes.compose(renumber),
      selection: tr.state.selection.map(renumber),
      scrollIntoView: true,
      userEvent: tr.annotation(Transaction.userEvent) ?? "input",
    }),
  );
};

/** Line break that keeps the line's leading whitespace. */
const plainBreak = (state: EditorState, range: SelectionRange) => {
  const line = state.doc.lineAt(range.from);
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";
  const keep = indent.slice(0, Math.max(0, range.from - line.from));
  // Whitespace right after the cursor would start the new line; drop it.
  const after =
    /^[ \t]*/.exec(state.sliceDoc(range.to, line.to))?.[0].length ?? 0;
  const insert = `\n${keep}`;
  return {
    changes: { from: range.from, to: range.to + after, insert },
    range: EditorSelection.cursor(range.from + insert.length),
  };
};

/**
 * Line break whose new line starts under the text of the current one: under
 * a list item's text, inside the same quote, or at the same indentation.
 */
const alignedBreak = (state: EditorState, range: SelectionRange) => {
  const line = state.doc.lineAt(range.head);
  const markup = parseLineMarkup(line.text);
  let insert = "\n";
  if (markup.marker) {
    const width = markup.contentStart - markup.markerStart;
    insert += `${markup.quote}${markup.indent}${" ".repeat(width)}`;
  } else if (markup.quote) {
    insert += markup.quote.endsWith(" ") ? markup.quote : `${markup.quote} `;
  } else {
    insert += /^[ \t]*/.exec(line.text)?.[0] ?? "";
  }
  return {
    changes: { from: range.from, to: range.to, insert },
    range: EditorSelection.cursor(range.from + insert.length),
  };
};

/**
 * Enter: continue the list or quote the cursor is in. An empty item ends the
 * list (or moves up a level when nested), an empty quote line leaves one
 * quote level, and ordered lists renumber. Inside fenced code a new line
 * only lines up with the text above.
 */
export const continueMarkup: StateCommand = ({ state, dispatch }) => {
  const touched: number[] = [];
  const moved = new Set<number>();
  const tr = state.update(
    state.changeByRange((range) => {
      if (!range.empty) {
        const changes = { from: range.from, to: range.to, insert: "\n" };
        return { changes, range: EditorSelection.cursor(range.from + 1) };
      }
      if (isInCode(state, range.head)) return alignedBreak(state, range);
      const line = state.doc.lineAt(range.head);
      const markup = parseLineMarkup(line.text);
      const column = range.head - line.from;
      const content = line.text.slice(markup.contentStart);

      if (markup.marker) {
        if (column < markup.contentStart - markup.checkbox.length) {
          return plainBreak(state, range);
        }
        if (content.trim() === "") {
          if (markup.indent !== "") {
            const indent = outdented(state, markup.indent);
            const from = line.from + markup.quote.length;
            touched.push(line.number);
            moved.add(line.number);
            return {
              changes: {
                from,
                to: from + markup.indent.length,
                insert: indent,
              },
              range: EditorSelection.cursor(
                line.to - markup.indent.length + indent.length,
              ),
            };
          }
          const from = line.from + markup.markerStart;
          return {
            changes: { from, to: line.to, insert: "" },
            range: EditorSelection.cursor(from),
          };
        }
        const insert = `\n${markup.quote}${markup.indent}${nextMarker(markup)}${
          markup.spacing || " "
        }${markup.checkbox ? "[ ] " : ""}`;
        touched.push(line.number + 1);
        return {
          changes: { from: range.head, insert },
          range: EditorSelection.cursor(range.head + insert.length),
        };
      }

      if (markup.quote) {
        if (content.trim() === "") {
          const outer = outerQuote(markup.quote);
          const outerPrefix = outer ? `${outer.trimEnd()} ` : "";
          const insert = `${outerPrefix}\n${outerPrefix}`;
          return {
            changes: { from: line.from, to: line.to, insert },
            range: EditorSelection.cursor(line.from + insert.length),
          };
        }
        const prefix = markup.quote.endsWith(" ")
          ? markup.quote
          : `${markup.quote} `;
        const insert = `\n${prefix}`;
        return {
          changes: { from: range.head, insert },
          range: EditorSelection.cursor(range.head + insert.length),
        };
      }

      return plainBreak(state, range);
    }),
    { scrollIntoView: true, userEvent: "input" },
  );
  dispatchRenumbered(dispatch, tr, touched, moved);
  return true;
};

/**
 * Shift-Enter: a line break inside the current item, aligned with its text,
 * or a new line in the current quote.
 */
export const continueMarkupSoft: StateCommand = ({ state, dispatch }) => {
  dispatch(
    state.update(
      state.changeByRange((range) => alignedBreak(state, range)),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
  return true;
};

const indentWithRenumbering =
  (indent: StateCommand): StateCommand =>
  ({ state, dispatch }) => {
    let tr: Transaction | null = null;
    indent({
      state,
      dispatch: (next) => {
        tr = next;
      },
    });
    const result = tr as Transaction | null;
    if (!result) return true;
    const lines = new Set<number>();
    for (const range of result.state.selection.ranges) {
      const first = result.state.doc.lineAt(range.from).number;
      const last = result.state.doc.lineAt(range.to).number;
      for (let n = first; n <= last; n++) lines.add(n);
    }
    const inCode = state.selection.ranges.some((r) => isInCode(state, r.head));
    if (inCode) {
      dispatch(result);
      return true;
    }
    // The old level's next items renumber too: they sit in the same block.
    dispatchRenumbered(dispatch, result, lines, lines);
    return true;
  };

/** Tab: indent the selected lines one level; ordered items renumber. */
export const indentListMore = indentWithRenumbering(indentMore);

/** Shift-Tab: outdent the selected lines one level; ordered items renumber. */
export const indentListLess = indentWithRenumbering(indentLess);

/**
 * Where Home goes on a list or quote line: just after the markup, unless the
 * cursor is already there or before it (then the line start is next). Null
 * defers to the regular line-start motion.
 */
export const lineStartAfterMarkup = (
  state: EditorState,
  pos: number,
): number | null => {
  const line = state.doc.lineAt(pos);
  const markup = parseLineMarkup(line.text);
  if (!markup.marker && !markup.quote) return null;
  const target = line.from + markup.contentStart;
  return pos > target ? target : null;
};
