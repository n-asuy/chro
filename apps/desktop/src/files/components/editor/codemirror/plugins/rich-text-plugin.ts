/**
 * Rich text plugin for WYSIWYG markdown editing
 * Hides markdown syntax tokens when not editing them
 *
 * Based on a reference CodeMirror rich-text Markdown plugin
 */

import type {
  DecorationSet,
  EditorView,
  ViewUpdate,
  PluginValue,
} from "@codemirror/view";
import { Decoration } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import { cursorInNode } from "../utility/tools";
import { decorationBullet, decorationHidden } from "../utility/decorations";

/**
 * Component tokens that should reveal their mark tokens when cursor is inside
 */
const revealComponentMarkTokensOnCursor = [
  "InlineCode",
  "Emphasis",
  "StrongEmphasis",
  "FencedCode",
  "Strikethrough",
  "Link",
  "Image",
  "Embed",
  "InternalLink",
  "Mark",
  "Comment",
  "Footnote",
  "FootnoteReference",
];

/**
 * Mark tokens that should be hidden when cursor is outside their parent component
 */
const hideComponentMarkTokens = [
  "EmphasisMark",
  "StrongEmphasisMark",
  "StrongMark",
  "CodeMark",
  "CodeInfo",
  "StrikethroughMark",
  "EmbedMark",
  "InternalMark",
  "MarkMarker",
  "FootnoteMark",
  "CommentMarker",
  "LinkMark",
];

/**
 * RichEditPlugin handles WYSIWYG-style editing by:
 * 1. Hiding markdown syntax tokens (**, __, ``, etc.) when not editing
 * 2. Revealing tokens when cursor is within the formatted text
 * 3. Applying decorations for visual elements like bullets
 */
export class RichEditPlugin implements PluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.process(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      // If selection also changed, reprocess everything
      if (update.selectionSet) {
        this.decorations = this.process(update.view);
      } else {
        // Only doc changed, optimize by processing changed ranges only
        let decorations = this.decorations.map(update.changes);
        update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
          const newWidgets = this.processRange(update.view, fromB, toB);
          decorations = decorations.update({
            filter: (f, t) => f < fromB || t > toB,
            add: newWidgets,
            sort: true,
          });
        });
        this.decorations = decorations;
      }
    } else if (update.viewportChanged || update.selectionSet) {
      this.decorations = this.process(update.view);
    }
  }

  process(view: EditorView): DecorationSet {
    const widgets: Range<Decoration>[] = [];
    for (const { from, to } of view.visibleRanges) {
      widgets.push(...this.processRange(view, from, to));
    }
    return Decoration.set(widgets, true);
  }

  processRange(
    view: EditorView,
    from: number,
    to: number,
  ): Range<Decoration>[] {
    const widgets: Range<Decoration>[] = [];
    const [cursor] = view.state.selection.ranges;

    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const nodeName = node.name;
        const nodeFrom = node.from;
        const nodeTo = node.to;

        // Handle horizontal rules
        if (nodeName === "HorizontalRule") {
          if (cursorInNode(cursor?.from, cursor?.to, nodeFrom, nodeTo)) {
            return;
          }
          const line = view.state.doc.lineAt(nodeFrom);
          widgets.push(decorationHidden.range(nodeFrom, nodeTo));
          widgets.push(
            Decoration.line({ attributes: { class: "hr" } }).range(line.from),
          );
          return;
        }

        // Reveal mark tokens when cursor is inside component
        if (
          (nodeName.startsWith("ATXHeading") ||
            revealComponentMarkTokensOnCursor.includes(nodeName)) &&
          cursorInNode(cursor?.from, cursor?.to, nodeFrom, nodeTo)
        ) {
          return false; // Returning false reveals the marks
        }

        // Handle bullet list markers (skip task list items — handled by task-list-plugin)
        if (
          nodeName === "ListMark" &&
          node.matchContext(["BulletList", "ListItem"]) &&
          cursor?.from !== nodeFrom &&
          cursor?.from !== nodeFrom + 1
        ) {
          const after = view.state.doc.sliceString(nodeTo, nodeTo + 4);
          const isTaskListItem = /^ \[.\]/.test(after);
          if (!isTaskListItem) {
            widgets.push(decorationBullet.range(nodeFrom, nodeTo));
          }
        }

        // Hide mark tokens when cursor is outside
        if (hideComponentMarkTokens.includes(node.name)) {
          widgets.push(decorationHidden.range(nodeFrom, nodeTo));
        }

        // Hide header marks separately
        if (nodeName === "HeaderMark") {
          widgets.push(decorationHidden.range(nodeFrom, nodeTo + 1));
        }
      },
    });

    return widgets;
  }
}
