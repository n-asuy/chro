/**
 * Highlight decoration plugin
 * Renders ==highlighted== text with visual styling
 */

import { hasDecorationRefresh } from "../decoration-refresh";
import { syntaxTree } from "@codemirror/language";
import { RangeSet, StateField } from "@codemirror/state";
import type { Range as EditorRange, EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import {
  cursorSelectionCoveredNode,
  isNodeRangeActive,
  toCursorNodePositions,
} from "../../utility/tools";

function buildHighlightDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Mark") {
        const markers = node.node.getChildren("MarkMarker");
        if (markers.length < 2) return;

        const openMark = state.doc.sliceString(
          markers[0]?.from ?? 0,
          markers[0]?.to ?? 0,
        );
        if (openMark !== "==") return;

        const closeMark = state.doc.sliceString(
          markers[markers.length - 1]?.from ?? 0,
          markers[markers.length - 1]?.to ?? 0,
        );
        if (closeMark !== "==") return;

        const poses = toCursorNodePositions(state, node);
        if (
          isNodeRangeActive(state, node.from, node.to) ||
          cursorSelectionCoveredNode(
            poses.cursorFrom,
            poses.cursorTo,
            poses.nodeFrom,
            poses.nodeTo,
          )
        ) {
          return;
        }

        const startContent = markers[0]?.to ?? 0;
        const endContent = markers[markers.length - 1]?.from ?? 0;

        // An empty highlight such as "====" has no content between the
        // markers, so startContent === endContent. CodeMirror's
        // Decoration.mark() throws "Mark decorations may not be empty" for a
        // zero-width range, which would crash the whole editor. Leave the raw
        // text undecorated in that case.
        if (endContent <= startContent) return;

        decorations.push(
          Decoration.mark({
            class: "cm-highlighted",
            tagName: "span",
          }).range(startContent, endContent),
        );

        decorations.push(
          Decoration.replace({}).range(
            markers[0]?.from ?? 0,
            markers[0]?.to ?? 0,
          ),
        );
        decorations.push(
          Decoration.replace({}).range(
            markers[markers.length - 1]?.from ?? 0,
            markers[markers.length - 1]?.to ?? 0,
          ),
        );
      }
    },
  });

  return decorations;
}

export const highlightPlugin = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildHighlightDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || hasDecorationRefresh(tr)) {
      return RangeSet.of(buildHighlightDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
