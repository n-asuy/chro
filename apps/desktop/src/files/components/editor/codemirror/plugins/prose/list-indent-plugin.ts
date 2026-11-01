/**
 * Nested list indentation: each indentation level of a list item renders as a
 * fixed-width step with a vertical guide, so nesting reads at a glance and
 * does not depend on how wide a tab or space is in the prose font.
 */

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { parseLineMarkup } from "../editor/markdown-lists";

const indentStep = Decoration.mark({ class: "cm-indent" });
const listLine = Decoration.line({ class: "cm-list-line" });

/** Split leading whitespace into levels: one tab, or one tab-width of spaces. */
const indentLevels = (indent: string, tabSize: number): [number, number][] => {
  const levels: [number, number][] = [];
  let start = 0;
  while (start < indent.length) {
    if (indent[start] === "\t") {
      levels.push([start, start + 1]);
      start += 1;
      continue;
    }
    let end = start;
    while (
      end < indent.length &&
      indent[end] === " " &&
      end - start < tabSize
    ) {
      end += 1;
    }
    if (end === start) break;
    levels.push([start, end]);
    start = end;
  }
  return levels;
};

const inFencedCode = (state: EditorState, pos: number): boolean => {
  for (
    let node: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null =
      syntaxTree(state).resolveInner(pos, 1);
    node;
    node = node.parent
  ) {
    if (node.name === "FencedCode") return true;
  }
  return false;
};

const build = (view: EditorView): DecorationSet => {
  const { state } = view;
  const decorations: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      pos = line.to + 1;
      const markup = parseLineMarkup(line.text);
      if (!markup.marker || inFencedCode(state, line.from)) continue;
      decorations.push(listLine.range(line.from));
      const indentFrom = line.from + markup.quote.length;
      for (const [start, end] of indentLevels(markup.indent, state.tabSize)) {
        decorations.push(
          indentStep.range(indentFrom + start, indentFrom + end),
        );
      }
    }
  }
  return Decoration.set(decorations, true);
};

export const listIndentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
