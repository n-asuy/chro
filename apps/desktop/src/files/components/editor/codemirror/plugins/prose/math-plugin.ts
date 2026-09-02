/**
 * Math formula rendering plugin
 * Renders LaTeX math expressions using KaTeX
 *
 * Syntax:
 * - Inline: $E = mc^2$
 * - Block: $$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$
 */

import { memoizeByParsedDoc } from "../decoration-cache";
import { needsDecorationRebuild } from "../decoration-refresh";
import {
  Decoration,
  EditorView,
  WidgetType,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  StateField,
  RangeSet,
  type EditorState,
  type Range as EditorRange,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import { cursorInNode } from "../../utility/tools";

// Lazy load KaTeX to avoid SSR issues
let katexInstance: typeof import("katex") | null = null;

async function getKaTeX() {
  if (!katexInstance) {
    katexInstance = await import("katex");
  }
  return katexInstance;
}

// Store view reference for click handling
let mathCurrentView: EditorView | null = null;

/**
 * Helper to add click handler for editing mode
 */
function addMathClickHandler(container: HTMLElement, nodeFrom: number): void {
  container.style.cursor = "pointer";
  container.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (mathCurrentView) {
      const view = mathCurrentView;
      view.dispatch({
        selection: { anchor: nodeFrom + 1 }, // Move cursor inside the math syntax
        scrollIntoView: true,
      });
      view.focus();
    }
  });
}

/**
 * Widget for inline math ($...$)
 */
class InlineMathWidget extends WidgetType {
  private rendered = false;

  constructor(
    private latex: string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("span");
    container.className = "cm-math cm-math-inline";

    // Add click handler to enter edit mode
    addMathClickHandler(container, this.nodeFrom);

    // Render asynchronously
    this.renderMath(container);

    return container;
  }

  private async renderMath(container: HTMLElement): Promise<void> {
    if (this.rendered) return;

    try {
      const katex = await getKaTeX();
      katex.default.render(this.latex, container, {
        throwOnError: false,
        displayMode: false,
        output: "html",
        trust: false,
        strict: false,
      });
      container.classList.add("cm-math-rendered");
      this.rendered = true;
    } catch (error) {
      container.classList.add("cm-math-error");
      container.textContent = this.latex;
      container.title =
        error instanceof Error ? error.message : "Failed to render math";
    }
  }

  eq(other: InlineMathWidget): boolean {
    return this.latex === other.latex && this.nodeFrom === other.nodeFrom;
  }
}

/**
 * Widget for block math ($$...$$)
 */
class BlockMathWidget extends WidgetType {
  private rendered = false;

  constructor(
    private latex: string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-math cm-math-block";

    // Add click handler to enter edit mode
    addMathClickHandler(container, this.nodeFrom);

    // Render asynchronously
    this.renderMath(container);

    return container;
  }

  private async renderMath(container: HTMLElement): Promise<void> {
    if (this.rendered) return;

    try {
      const katex = await getKaTeX();
      katex.default.render(this.latex, container, {
        throwOnError: false,
        displayMode: true,
        output: "html",
        trust: false,
        strict: false,
      });
      container.classList.add("cm-math-rendered");
      this.rendered = true;
    } catch (error) {
      container.classList.add("cm-math-error");
      container.textContent = this.latex;
      container.title =
        error instanceof Error ? error.message : "Failed to render math";
    }
  }

  eq(other: BlockMathWidget): boolean {
    return this.latex === other.latex && this.nodeFrom === other.nodeFrom;
  }

  get estimatedHeight(): number {
    return 60;
  }
}

interface MathBlockInfo {
  latex: string;
  from: number;
  to: number;
  isBlock: boolean;
}

/**
 * Find math expressions in the syntax tree
 */
function findMathBlocks(state: EditorState): MathBlockInfo[] {
  const blocks: MathBlockInfo[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      // Handle block math ($$...$$)
      if (node.name === "TexBlock") {
        const fullText = state.doc.sliceString(node.from, node.to);
        // Remove $$ delimiters
        const latex = fullText.slice(2, -2).trim();
        if (latex) {
          blocks.push({
            latex,
            from: node.from,
            to: node.to,
            isBlock: true,
          });
        }
      }
      // Handle inline math ($...$)
      else if (node.name === "TexInline") {
        const fullText = state.doc.sliceString(node.from, node.to);
        // Remove $ delimiters
        const latex = fullText.slice(1, -1).trim();
        if (latex) {
          blocks.push({
            latex,
            from: node.from,
            to: node.to,
            isBlock: false,
          });
        }
      }
    },
  });

  return blocks;
}

// The block scan depends only on the document; memoize it so cursor movement
// reuses the scan instead of re-walking the tree.
const findMathBlocksCached = memoizeByParsedDoc(findMathBlocks);

function buildMathDecorations(state: EditorState): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;
  const blocks = findMathBlocksCached(state);

  for (const block of blocks) {
    const isEditing = cursorInNode(
      cursor.from,
      cursor.to,
      block.from,
      block.to,
    );

    if (isEditing) {
      // Show raw LaTeX when editing
      decorations.push(
        Decoration.mark({
          class: "cm-math-editing",
        }).range(block.from, block.to),
      );
    } else {
      // Replace with rendered math when not editing
      if (block.isBlock) {
        decorations.push(
          Decoration.replace({
            widget: new BlockMathWidget(block.latex, block.from),
            block: true,
          }).range(block.from, block.to),
        );
      } else {
        decorations.push(
          Decoration.replace({
            widget: new InlineMathWidget(block.latex, block.from),
          }).range(block.from, block.to),
        );
      }
    }
  }

  return decorations;
}

const mathDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildMathDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || needsDecorationRebuild(tr)) {
      return RangeSet.of(buildMathDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * ViewPlugin to keep track of the current EditorView for click handling
 */
const mathViewPlugin = ViewPlugin.fromClass(
  class {
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      mathCurrentView = view;
    }

    update(_update: ViewUpdate) {
      // Keep the reference updated
      mathCurrentView = this.view;
    }

    destroy() {
      if (mathCurrentView === this.view) {
        mathCurrentView = null;
      }
    }
  },
);

/**
 * Combined math plugin with decorations and view tracking
 */
export const mathPlugin = [mathDecorationField, mathViewPlugin];
