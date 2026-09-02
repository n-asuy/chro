/**
 * Codeblock decoration plugin
 * Adds styling to fenced code block elements
 */

import { needsDecorationRebuild } from "../decoration-refresh";
import { Decoration, EditorView } from "@codemirror/view";
import { StateField, RangeSet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range as EditorRange } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { DecorationSet } from "@codemirror/view";

function isInsideBlockquote(node: SyntaxNode): boolean {
  // Walk the ancestor chain instead of scanning the whole tree per code block
  // (which was O(blocks × doc)). Callouts render their own fenced-code styling.
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Blockquote") return true;
  }
  return false;
}

function buildCodeblockDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "FencedCode") {
        // Skip code blocks inside blockquotes (callouts handle their own styling)
        if (isInsideBlockquote(node.node)) {
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
    // Code-block line styling depends only on the document, so cursor movement
    // does not need a rebuild (only doc edits or an explicit refresh do).
    if (tr.docChanged || needsDecorationRebuild(tr)) {
      return RangeSet.of(buildCodeblockDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
