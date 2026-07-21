/**
 * Callout decoration plugin
 * Renders Obsidian-style callouts with visual styling
 *
 * Syntax: > [!type] Title
 * Types: note, abstract, info, todo, tip, success, question, warning, failure, danger, bug, example, quote
 */

import { hasDecorationRefresh } from "../decoration-refresh";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  StateField,
  RangeSet,
  type EditorState,
  type Range as EditorRange,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import { cursorInNode } from "../../utility/tools";

/**
 * Callout type to color class mapping
 */
const CALLOUT_COLORS: Record<string, string> = {
  note: "callout-note",
  abstract: "callout-abstract",
  summary: "callout-abstract",
  tldr: "callout-abstract",
  info: "callout-info",
  todo: "callout-info",
  tip: "callout-tip",
  hint: "callout-tip",
  important: "callout-tip",
  success: "callout-success",
  check: "callout-success",
  done: "callout-success",
  question: "callout-question",
  help: "callout-question",
  faq: "callout-question",
  warning: "callout-warning",
  caution: "callout-warning",
  attention: "callout-warning",
  failure: "callout-failure",
  fail: "callout-failure",
  missing: "callout-failure",
  danger: "callout-danger",
  error: "callout-danger",
  bug: "callout-bug",
  example: "callout-example",
  quote: "callout-quote",
  cite: "callout-quote",
};

/**
 * Widget to display callout header with icon and title
 */
class CalloutHeaderWidget extends WidgetType {
  constructor(
    private type: string,
    private title: string,
    private isFolded: boolean,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const header = document.createElement("span");
    header.className = `cm-callout-header ${CALLOUT_COLORS[this.type.toLowerCase()] ?? "callout-note"}`;
    header.textContent =
      this.title || this.type.charAt(0).toUpperCase() + this.type.slice(1);

    if (this.isFolded) {
      const foldIcon = document.createElement("span");
      foldIcon.className = "cm-callout-fold";
      foldIcon.textContent = " ▶";
      header.appendChild(foldIcon);
    }

    return header;
  }

  eq(other: CalloutHeaderWidget): boolean {
    return (
      this.type === other.type &&
      this.title === other.title &&
      this.isFolded === other.isFolded
    );
  }
}

interface CalloutInfo {
  type: string;
  title: string;
  isFolded: boolean;
  blockquoteFrom: number;
  blockquoteTo: number;
  calloutLineFrom: number;
  calloutLineTo: number;
}

/**
 * Find callout information from a Blockquote node
 */
function findCalloutInBlockquote(
  state: EditorState,
  from: number,
  to: number,
): CalloutInfo | null {
  let calloutInfo: CalloutInfo | null = null;

  const firstLine = state.doc.lineAt(from);
  const lineText = firstLine.text;

  // Check if this blockquote contains a callout on the first line
  // Pattern: > [!type]+ title or > [!type]- title or > [!type] title
  const calloutMatch = lineText.match(/^>\s*\[!([^\]]+)\]([+-])?\s*(.*)?$/);

  if (calloutMatch) {
    const type = calloutMatch[1];
    const foldMark = calloutMatch[2];
    const title = calloutMatch[3]?.trim() ?? "";

    calloutInfo = {
      type,
      title,
      isFolded: foldMark === "-",
      blockquoteFrom: from,
      blockquoteTo: to,
      calloutLineFrom: firstLine.from,
      calloutLineTo: firstLine.to,
    };
  }

  return calloutInfo;
}

function buildCalloutDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Blockquote") {
        const calloutInfo = findCalloutInBlockquote(state, node.from, node.to);

        if (!calloutInfo) {
          return; // Not a callout, let default blockquote handling apply
        }

        const isEditing = cursorInNode(
          cursor.from,
          cursor.to,
          node.from,
          node.to,
        );
        const colorClass =
          CALLOUT_COLORS[calloutInfo.type.toLowerCase()] ?? "callout-note";

        // Get all lines in the blockquote
        const firstLine = state.doc.lineAt(node.from);
        const lastLine = state.doc.lineAt(node.to);

        for (
          let lineNum = firstLine.number;
          lineNum <= lastLine.number;
          lineNum++
        ) {
          const line = state.doc.line(lineNum);
          const isFirstLine = lineNum === firstLine.number;

          // Apply callout styling to each line
          let lineClass = `cm-callout ${colorClass}`;
          if (isFirstLine) {
            lineClass += " cm-callout-first";
          }
          if (lineNum === lastLine.number) {
            lineClass += " cm-callout-last";
          }
          if (isEditing) {
            lineClass += " cm-callout-editing";
          }

          decorations.push(
            Decoration.line({
              attributes: { class: lineClass },
            }).range(line.from),
          );

          // Hide the > marker when not editing (except first line which gets widget)
          if (!isEditing && !isFirstLine) {
            const markerMatch = line.text.match(/^(\s*>+\s*)/);
            if (markerMatch) {
              decorations.push(
                Decoration.replace({}).range(
                  line.from,
                  line.from + markerMatch[1].length,
                ),
              );
            }
          }
        }

        // Add callout header widget on the first line (when not editing)
        if (!isEditing) {
          // Find the end of callout syntax to replace just that part
          const calloutSyntaxMatch = firstLine.text.match(
            /^>\s*\[!([^\]]+)\]([+-])?\s*(.*)?$/,
          );
          if (calloutSyntaxMatch) {
            // Replace entire first line with header widget
            decorations.push(
              Decoration.replace({
                widget: new CalloutHeaderWidget(
                  calloutInfo.type,
                  calloutInfo.title,
                  calloutInfo.isFolded,
                ),
              }).range(firstLine.from, firstLine.to),
            );
          }
        }

        return false; // Don't recurse into children
      }
    },
  });

  return decorations;
}

export const calloutPlugin = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildCalloutDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || hasDecorationRefresh(tr)) {
      return RangeSet.of(buildCalloutDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
