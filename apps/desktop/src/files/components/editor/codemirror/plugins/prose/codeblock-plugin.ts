/**
 * Codeblock decoration plugin
 * Adds styling to fenced code block elements
 */

import { Decoration, EditorView } from "@codemirror/view";
import { StateField, RangeSet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range as EditorRange } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

function isInsideBlockquote(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let insideBlockquote = false;
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.name === "Blockquote") {
        if (node.from <= from && node.to >= to) {
          insideBlockquote = true;
        }
      }
    },
  });
  return insideBlockquote;
}

function buildCodeblockDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "FencedCode") {
        // Skip code blocks inside blockquotes (callouts handle their own styling)
        if (isInsideBlockquote(state, node.from, node.to)) {
          return false;
        }

        const firstLine = state.doc.lineAt(node.from);
        const lastLine = state.doc.lineAt(node.to);
        const lineCount = lastLine.number - firstLine.number + 1;

        for (let i = firstLine.number; i <= lastLine.number; i++) {
          const line = state.doc.line(i);
          let lineClass = "cm-codeblock";

          if (lineCount === 1) {
            lineClass += " cm-line-codeblock-single";
          } else if (i === firstLine.number) {
            lineClass += " cm-line-codeblock-begin";
          } else if (i === lastLine.number) {
            lineClass += " cm-line-codeblock-end";
          } else {
            lineClass += " cm-line-codeblock-middle";
          }

          decorations.push(
            Decoration.line({
              attributes: { class: lineClass },
            }).range(line.from),
          );
        }

        return false;
      }
    },
  });

  return decorations;
}

export const codeblockPlugin = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildCodeblockDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.length > 0) {
      return RangeSet.of(buildCodeblockDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
