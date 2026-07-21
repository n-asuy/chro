/**
 * Quoteblock decoration plugin
 * Adds styling to blockquote elements
 */

import { hasDecorationRefresh } from "../decoration-refresh";
import { Decoration, EditorView } from "@codemirror/view";
import { StateField, RangeSet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range as EditorRange } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { cursorSelectionCoveredNode } from "../../utility/tools";

function isCursorOnLine(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): boolean {
  const cursor = state.selection.main;
  return cursor.from >= lineStart && cursor.from <= lineEnd;
}

function buildQuoteblockDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Blockquote") {
        const firstLine = state.doc.lineAt(node.from);
        const lastLine = state.doc.lineAt(node.to);
        const lineCount = lastLine.number - firstLine.number + 1;

        const [cursor] = state.selection.ranges;
        const cursorFrom = cursor?.from ?? 0;
        const cursorTo = cursor?.to ?? 0;
        const nodeFrom = node.from;
        const nodeTo = node.to;

        for (let i = firstLine.number; i <= lastLine.number; i++) {
          const line = state.doc.line(i);
          let lineClass = "cm-quoteblock";

          if (lineCount === 1) {
            lineClass += " cm-quoteblock-single";
          } else if (i === firstLine.number) {
            lineClass += " cm-quoteblock-start";
          } else if (i === lastLine.number) {
            lineClass += " cm-quoteblock-end";
          } else {
            lineClass += " cm-quoteblock-middle";
          }

          decorations.push(
            Decoration.line({
              attributes: { class: lineClass },
            }).range(line.from),
          );

          const isCursorActive =
            isCursorOnLine(state, line.from, line.to) ||
            cursorSelectionCoveredNode(cursorFrom, cursorTo, nodeFrom, nodeTo);

          const lineText = line.text;
          const markMatch = lineText.match(/^(\s*>+)/);

          if (markMatch) {
            const markEnd = line.from + markMatch[0].length;
            let markClass = "cm-formatting cm-formatting-quote cm-meta";

            if (isCursorActive) {
              markClass += " cm-formatting-quote-active";
            }

            decorations.push(
              Decoration.mark({
                class: markClass,
              }).range(line.from, markEnd),
            );

            if (markEnd < line.to) {
              decorations.push(
                Decoration.mark({
                  class: "cm-quote",
                }).range(markEnd, line.to),
              );
            }
          }
        }

        return false;
      }
    },
  });

  return decorations;
}

export const quoteblockPlugin = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildQuoteblockDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || hasDecorationRefresh(tr)) {
      return RangeSet.of(buildQuoteblockDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
