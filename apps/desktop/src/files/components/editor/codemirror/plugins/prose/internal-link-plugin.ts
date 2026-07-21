/**
 * Internal link decoration plugin
 * Adds styling and click handling to [[internal links]]
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
 * Widget to display external link icon for internal links
 */
class InternalLinkIconWidget extends WidgetType {
  constructor() {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-internal-link-icon";
    span.textContent = "↗";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  eq(): boolean {
    return true;
  }
}

/**
 * Extract link path from an InternalLink node
 */
function extractLinkPath(state: EditorState, from: number, to: number): string {
  let linkPath = "";

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === "InternalPath") {
        linkPath = state.doc.sliceString(node.from, node.to);
      }
    },
  });

  return linkPath;
}

/**
 * Extract display text from an InternalLink node
 * Falls back to the path if no display text is set
 */
function extractDisplayText(
  state: EditorState,
  from: number,
  to: number,
): string {
  let displayText = "";
  let pathText = "";

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === "InternalPath") {
        pathText = state.doc.sliceString(node.from, node.to);
      }
      if (node.name === "InternalDisplay") {
        displayText = state.doc.sliceString(node.from, node.to);
      }
    },
  });

  return displayText || pathText;
}

function buildInternalLinkDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "InternalLink") {
        const isEditing = cursorInNode(
          cursor.from,
          cursor.to,
          node.from,
          node.to,
        );
        const linkPath = extractLinkPath(state, node.from, node.to);
        const displayText = extractDisplayText(state, node.from, node.to);

        // Always add the base link decoration
        decorations.push(
          Decoration.mark({
            class: `cm-internal-link${isEditing ? " cm-internal-link-editing" : ""}`,
            attributes: {
              "data-link-path": linkPath,
              "data-display-text": displayText,
              title: linkPath,
            },
          }).range(node.from, node.to),
        );

        // When not editing, hide the markers and path (show only display text)
        if (!isEditing) {
          // Find and hide the opening [[
          syntaxTree(state).iterate({
            from: node.from,
            to: node.to,
            enter(child) {
              if (child.name === "InternalMark") {
                decorations.push(
                  Decoration.replace({
                    class: "cm-internal-link-hidden",
                  }).range(child.from, child.to),
                );
              }
              // Hide the path if there's a display text
              if (child.name === "InternalPath") {
                const hasDisplay = displayText !== linkPath;
                if (hasDisplay) {
                  decorations.push(
                    Decoration.replace({
                      class: "cm-internal-link-path-hidden",
                    }).range(child.from, child.to),
                  );
                }
              }
              if (child.name === "InternalSubpath") {
                decorations.push(
                  Decoration.replace({
                    class: "cm-internal-link-subpath-hidden",
                  }).range(child.from, child.to),
                );
              }
            },
          });

          // Add icon widget after the link
          decorations.push(
            Decoration.widget({
              widget: new InternalLinkIconWidget(),
              side: 1,
            }).range(node.to),
          );
        }
      }
    },
  });

  return decorations;
}

export const internalLinkPlugin = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildInternalLinkDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || hasDecorationRefresh(tr)) {
      return RangeSet.of(buildInternalLinkDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Click handler for internal links
 * Mirrors Obsidian's "single-click to open" behavior.
 * - Plain left click follows the link.
 * - Holding Ctrl/Cmd while clicking keeps the default editing behavior.
 *
 * Uses mousedown event to capture the click before CodeMirror's selection handling.
 */
export function createInternalLinkClickHandler(
  onLinkClick: (path: string) => void,
) {
  return EditorView.domEventHandlers({
    mousedown(event) {
      const target = event.target as HTMLElement;
      const linkElement = target.closest(".cm-internal-link");

      if (!linkElement || event.defaultPrevented) {
        return false;
      }

      // Check if cursor is inside the link (editing mode)
      // In editing mode, the link shows raw markdown and should be editable
      if (linkElement.classList.contains("cm-internal-link-editing")) {
        return false;
      }

      const linkPath = linkElement.getAttribute("data-link-path");
      if (!linkPath) {
        return false;
      }

      const isPrimaryButton = event.button === 0;
      const hasNavigationModifiers =
        !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

      if (isPrimaryButton && hasNavigationModifiers) {
        event.preventDefault();
        event.stopPropagation();
        onLinkClick(linkPath);
        return true;
      }

      // Allow default behavior (text selection/editing) when modifier keys are used
      return false;
    },
  });
}
