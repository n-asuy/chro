/**
 * Inline formatting, links, comments and checklists. Shared by the keyboard
 * shortcuts and the selection bubble menu.
 */

import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type StateCommand,
} from "@codemirror/state";
import { parseLineMarkup } from "./markdown-lists";

/** Count consecutive `char`s next to `pos`, going left or right. */
const runLength = (
  state: EditorState,
  pos: number,
  direction: -1 | 1,
  char: string,
): number => {
  let count = 0;
  let cursor = direction === -1 ? pos - 1 : pos;
  while (cursor >= 0 && cursor < state.doc.length) {
    if (state.sliceDoc(cursor, cursor + 1) !== char) break;
    count += 1;
    cursor += direction;
  }
  return count;
};

/**
 * Whether `mark` directly surrounds [from, to]. Star runs are ambiguous
 * ("***x***" is bold and italic), so "*" needs an odd run on both sides and
 * "**" a run of at least two.
 */
const isWrappedBy = (
  state: EditorState,
  from: number,
  to: number,
  mark: string,
): boolean => {
  if (mark === "*" || mark === "**") {
    const left = runLength(state, from, -1, "*");
    const right = runLength(state, to, 1, "*");
    return mark === "*"
      ? left % 2 === 1 && right % 2 === 1
      : left >= 2 && right >= 2;
  }
  if (from < mark.length || to + mark.length > state.doc.length) return false;
  return (
    state.sliceDoc(from - mark.length, from) === mark &&
    state.sliceDoc(to, to + mark.length) === mark
  );
};

/** Whether the text of [from, to] starts and ends with `mark`. */
const containsWrapped = (
  state: EditorState,
  from: number,
  to: number,
  mark: string,
): boolean => {
  const text = state.sliceDoc(from, to);
  return (
    text.length >= mark.length * 2 &&
    text.startsWith(mark) &&
    text.endsWith(mark)
  );
};

type MarkOptions = {
  /** With an empty selection on a word, select the word after wrapping it. */
  selectWord?: boolean;
};

const toggleMarkInRange = (
  state: EditorState,
  range: SelectionRange,
  mark: string,
  { selectWord = false }: MarkOptions,
) => {
  const n = mark.length;
  if (!range.empty) {
    const { from, to } = range;
    if (isWrappedBy(state, from, to, mark)) {
      return {
        changes: [
          { from: from - n, to: from },
          { from: to, to: to + n },
        ],
        range: EditorSelection.range(from - n, to - n),
      };
    }
    if (containsWrapped(state, from, to, mark)) {
      return {
        changes: [
          { from, to: from + n },
          { from: to - n, to },
        ],
        range: EditorSelection.range(from, to - 2 * n),
      };
    }
    return {
      changes: [
        { from, insert: mark },
        { from: to, insert: mark },
      ],
      range: EditorSelection.range(from + n, to + n),
    };
  }

  const pos = range.head;
  const word = state.wordAt(pos);
  if (!word) {
    return {
      changes: { from: pos, insert: mark + mark },
      range: EditorSelection.cursor(pos + n),
    };
  }
  if (isWrappedBy(state, word.from, word.to, mark)) {
    return {
      changes: [
        { from: word.from - n, to: word.from },
        { from: word.to, to: word.to + n },
      ],
      range: EditorSelection.cursor(pos - n),
    };
  }
  const changes = [
    { from: word.from, insert: mark },
    { from: word.to, insert: mark },
  ];
  if (selectWord) {
    return {
      changes,
      range: EditorSelection.range(word.from + n, word.to + n),
    };
  }
  // A cursor at the end of the word ends up after the closing mark.
  return {
    changes,
    range: EditorSelection.cursor(pos === word.to ? pos + 2 * n : pos + n),
  };
};

const toggleMark =
  (mark: string, options: MarkOptions = {}): StateCommand =>
  ({ state, dispatch }) => {
    dispatch(
      state.update(
        state.changeByRange((range) =>
          toggleMarkInRange(state, range, mark, options),
        ),
        { scrollIntoView: true, userEvent: "input" },
      ),
    );
    return true;
  };

/**
 * Wrap the selection (or the word at the cursor) in `mark`, or unwrap it when
 * already wrapped. An empty cursor outside a word inserts a pair.
 */
export const toggleInlineMark = (mark: string): StateCommand =>
  toggleMark(mark);

export const toggleBold = toggleInlineMark("**");
export const toggleItalic = toggleInlineMark("*");
export const toggleStrikethrough = toggleInlineMark("~~");
export const toggleHighlight = toggleInlineMark("==");
export const toggleInlineCode = toggleInlineMark("`");

/** Wrap in (or unwrap from) a %%comment%%; a word at the cursor is selected. */
export const toggleComment = toggleMark("%%", { selectWord: true });

/** Whether every selection is directly wrapped in `mark`. */
export const hasInlineMark = (state: EditorState, mark: string): boolean =>
  state.selection.ranges.every(
    (range) => !range.empty && isWrappedBy(state, range.from, range.to, mark),
  );

/**
 * Turn the selection into a link label with the cursor in the URL, or insert
 * an empty link with the cursor in the label.
 */
export const insertMarkdownLink: StateCommand = ({ state, dispatch }) => {
  dispatch(
    state.update(
      state.changeByRange((range) => {
        if (range.empty) {
          return {
            changes: { from: range.from, insert: "[]()" },
            range: EditorSelection.cursor(range.from + 1),
          };
        }
        return {
          changes: [
            { from: range.from, insert: "[" },
            { from: range.to, insert: "]()" },
          ],
          range: EditorSelection.cursor(range.to + 3),
        };
      }),
      { scrollIntoView: true, userEvent: "input" },
    ),
  );
  return true;
};

/**
 * Cycle each selected line: plain text becomes an unchecked task, a list
 * item gains a checkbox, and a task's checkbox toggles.
 */
export const toggleChecklist: StateCommand = ({ state, dispatch }) => {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  const changes = [...lines].map((n) => {
    const line = state.doc.line(n);
    const markup = parseLineMarkup(line.text);
    if (markup.checkbox) {
      const at = line.from + markup.contentStart - markup.checkbox.length + 1;
      const checked = state.sliceDoc(at, at + 1) !== " ";
      return { from: at, to: at + 1, insert: checked ? " " : "x" };
    }
    if (markup.marker) {
      const at = line.from + markup.contentStart;
      return { from: at, insert: markup.spacing ? "[ ] " : " [ ] " };
    }
    return { from: line.from + markup.quote.length, insert: "- [ ] " };
  });
  const changeSet = state.changes(changes);
  dispatch(
    state.update({
      changes: changeSet,
      // Cursors sitting where markup is inserted move past it.
      selection: state.selection.map(changeSet, 1),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/**
 * Delete the lines the selection touches. The cursor keeps its character
 * column on the line that moves up, or ends the previous line when the
 * document's last lines went.
 */
export const deleteParagraph: StateCommand = ({ state, dispatch }) => {
  const { doc } = state;
  const head = state.selection.main.head;
  const headLine = doc.lineAt(head);
  const column = head - headLine.from;
  let first = doc.lineAt(state.selection.main.from).number;
  let last = doc.lineAt(state.selection.main.to).number;
  for (const range of state.selection.ranges) {
    first = Math.min(first, doc.lineAt(range.from).number);
    last = Math.max(last, doc.lineAt(range.to).number);
  }
  const atEnd = last === doc.lines;
  const from =
    atEnd && first > 1 ? doc.line(first - 1).to : doc.line(first).from;
  const to = atEnd ? doc.line(last).to : doc.line(last + 1).from;
  const changes = state.changes({ from, to });
  const next = changes.apply(doc);
  let cursor: number;
  if (atEnd) {
    cursor = next.length;
  } else {
    const line = next.lineAt(from);
    cursor = line.from + Math.min(column, line.length);
  }
  dispatch(
    state.update({
      changes,
      selection: EditorSelection.cursor(cursor),
      scrollIntoView: true,
      userEvent: "delete.line",
    }),
  );
  return true;
};
