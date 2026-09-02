/**
 * Mermaid diagram rendering plugin
 * Renders mermaid code blocks as SVG diagrams with zoom/pan controls
 *
 * Syntax:
 * ```mermaid
 * graph TD
 *   A --> B
 * ```
 */

import { memoizeByParsedDoc } from "../decoration-cache";
import { needsDecorationRebuild } from "../decoration-refresh";
import { syntaxTree } from "@codemirror/language";
import {
  type Range as EditorRange,
  type EditorState,
  RangeSet,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { cursorInNode } from "../../utility/tools";
import {
  ICON_RESET,
  ICON_ZOOM_IN,
  ICON_ZOOM_OUT,
  openExpandedView,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from "@/lib/mermaid-expanded-view";

// Lazy load mermaid to avoid SSR issues
let mermaidInstance: typeof import("mermaid").default | null = null;
let lastMermaidTheme: string | null = null;

function isDarkTheme(): boolean {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

async function getMermaid() {
  const theme = isDarkTheme() ? "dark" : "default";
  if (!mermaidInstance) {
    const mermaid = (await import("mermaid")).default;
    mermaidInstance = mermaid;
  }
  if (lastMermaidTheme !== theme) {
    mermaidInstance.initialize({
      startOnLoad: false,
      theme,
      securityLevel: "loose",
      fontFamily: "inherit",
    });
    lastMermaidTheme = theme;
  }
  return mermaidInstance;
}

// Cache for rendered diagrams
const diagramCache = new Map<string, string>();

// Invalidate cache when theme changes so diagrams re-render with the correct palette
const themeObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.attributeName === "data-theme") {
      diagramCache.clear();
      lastMermaidTheme = null;
    }
  }
});
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

// Counter for unique IDs
let diagramIdCounter = 0;

// Store view reference for click handling
let currentView: EditorView | null = null;

// --- Editor-only constants/icons (the shared ones live in mermaid-expanded-view) ---

const DRAG_THRESHOLD = 5;

const ICON_EDIT = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;

const ICON_EXPAND = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

/**
 * Navigate the editor cursor into the mermaid code block for editing
 */
function enterEditMode(blockFrom: number): void {
  if (!currentView) return;
  const view = currentView;
  const line = view.state.doc.lineAt(blockFrom);
  const nextLine = view.state.doc.line(line.number + 1);
  view.dispatch({
    selection: { anchor: nextLine.from },
    scrollIntoView: true,
  });
  view.focus();
}

/**
 * Widget to display rendered mermaid diagram with zoom/pan controls
 */
class MermaidWidget extends WidgetType {
  private rendered = false;
  private container: HTMLDivElement | null = null;
  private cleanupMouseMove: ((e: MouseEvent) => void) | null = null;
  private cleanupMouseUp: ((e: MouseEvent) => void) | null = null;

  constructor(
    private code: string,
    private id: string,
    private blockFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-mermaid-container";
    this.container = container;

    // --- Zoom/pan state (closure-local) ---
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let isDragging = false;
    let hasDragged = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let mouseDownX = 0;
    let mouseDownY = 0;

    // --- DOM structure: viewport > canvas, controls ---
    const viewport = document.createElement("div");
    viewport.className = "cm-mermaid-viewport";

    const canvas = document.createElement("div");
    canvas.className = "cm-mermaid-canvas";
    viewport.appendChild(canvas);
    container.appendChild(viewport);

    const applyTransform = () => {
      canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    };

    // --- Control buttons ---
    const controls = document.createElement("div");
    controls.className = "cm-mermaid-controls";

    const createButton = (
      icon: string,
      label: string,
      onClick: () => void,
    ): HTMLButtonElement => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cm-mermaid-control-btn";
      btn.setAttribute("aria-label", label);
      btn.innerHTML = icon;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      btn.addEventListener("mousedown", (e) => {
        e.stopPropagation();
      });
      return btn;
    };

    controls.appendChild(
      createButton(ICON_ZOOM_IN, "Zoom in", () => {
        scale = Math.min(scale + ZOOM_STEP, ZOOM_MAX);
        applyTransform();
      }),
    );

    controls.appendChild(
      createButton(ICON_ZOOM_OUT, "Zoom out", () => {
        scale = Math.max(scale - ZOOM_STEP, ZOOM_MIN);
        applyTransform();
      }),
    );

    controls.appendChild(
      createButton(ICON_RESET, "Reset zoom", () => {
        scale = 1;
        translateX = 0;
        translateY = 0;
        applyTransform();
      }),
    );

    const code = this.code;
    controls.appendChild(
      createButton(ICON_EXPAND, "Expand diagram", () => {
        const cached = diagramCache.get(code);
        if (cached) {
          openExpandedView(cached);
        }
      }),
    );

    const blockFrom = this.blockFrom;
    controls.appendChild(
      createButton(ICON_EDIT, "Edit source", () => {
        enterEditMode(blockFrom);
      }),
    );

    container.appendChild(controls);

    // --- Drag-to-pan with click-vs-drag disambiguation ---
    viewport.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      isDragging = true;
      hasDragged = false;
      dragStartX = e.clientX - translateX;
      dragStartY = e.clientY - translateY;
      mouseDownX = e.clientX;
      mouseDownY = e.clientY;
      viewport.style.cursor = "grabbing";
      e.preventDefault();
    });

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const dx = e.clientX - mouseDownX;
      const dy = e.clientY - mouseDownY;
      if (Math.sqrt(dx * dx + dy * dy) >= DRAG_THRESHOLD) {
        hasDragged = true;
      }

      translateX = e.clientX - dragStartX;
      translateY = e.clientY - dragStartY;
      applyTransform();
    };

    const handleMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      viewport.style.cursor = "";

      // Click (no drag) enters edit mode
      if (!hasDragged) {
        enterEditMode(blockFrom);
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    this.cleanupMouseMove = handleMouseMove;
    this.cleanupMouseUp = handleMouseUp;

    // --- Render SVG content ---
    const cached = diagramCache.get(this.code);
    if (cached) {
      canvas.innerHTML = cached;
      container.classList.add("cm-mermaid-rendered");
      this.rendered = true;
    } else {
      const loading = document.createElement("div");
      loading.className = "cm-mermaid-loading";
      loading.textContent = "Rendering diagram...";
      canvas.appendChild(loading);
      this.renderDiagram(canvas, container);
    }

    return container;
  }

  private async renderDiagram(
    canvas: HTMLDivElement,
    container: HTMLDivElement,
  ): Promise<void> {
    if (this.rendered) return;

    try {
      const mermaid = await getMermaid();
      const uniqueId = `mermaid-${this.id}-${Date.now()}`;

      const isValid = await mermaid.parse(this.code, { suppressErrors: true });
      if (!isValid) {
        this.showError(canvas, container, "Invalid mermaid syntax");
        return;
      }

      const { svg } = await mermaid.render(uniqueId, this.code);
      diagramCache.set(this.code, svg);

      canvas.innerHTML = svg;
      container.classList.add("cm-mermaid-rendered");
      this.rendered = true;
    } catch (error) {
      this.showError(
        canvas,
        container,
        error instanceof Error ? error.message : "Failed to render diagram",
      );
    }
  }

  private showError(
    canvas: HTMLDivElement,
    container: HTMLDivElement,
    message: string,
  ): void {
    canvas.innerHTML = "";
    container.classList.add("cm-mermaid-error");

    const errorDiv = document.createElement("div");
    errorDiv.className = "cm-mermaid-error-message";
    errorDiv.textContent = `Mermaid Error: ${message}`;
    canvas.appendChild(errorDiv);
  }

  eq(other: MermaidWidget): boolean {
    return this.code === other.code && this.blockFrom === other.blockFrom;
  }

  get estimatedHeight(): number {
    return 200;
  }

  destroy(): void {
    if (this.cleanupMouseMove) {
      document.removeEventListener("mousemove", this.cleanupMouseMove);
    }
    if (this.cleanupMouseUp) {
      document.removeEventListener("mouseup", this.cleanupMouseUp);
    }
    this.cleanupMouseMove = null;
    this.cleanupMouseUp = null;
    this.container = null;
  }
}

interface MermaidBlockInfo {
  code: string;
  blockFrom: number;
  blockTo: number;
  codeFrom: number;
  codeTo: number;
}

/**
 * Find mermaid code blocks in the syntax tree
 */
function findMermaidBlocks(state: EditorState): MermaidBlockInfo[] {
  const blocks: MermaidBlockInfo[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "FencedCode") {
        // Check if this is a mermaid code block
        let isMermaid = false;
        let codeFrom = node.from;
        let codeTo = node.to;

        // Find CodeInfo to check language
        syntaxTree(state).iterate({
          from: node.from,
          to: node.to,
          enter(child) {
            if (child.name === "CodeInfo") {
              const info = state.doc
                .sliceString(child.from, child.to)
                .trim()
                .toLowerCase();
              if (info === "mermaid") {
                isMermaid = true;
              }
            }
            if (child.name === "CodeText") {
              codeFrom = child.from;
              codeTo = child.to;
            }
          },
        });

        if (isMermaid) {
          // Extract the code content (without the fence markers)
          const fullText = state.doc.sliceString(node.from, node.to);
          const lines = fullText.split("\n");

          // Remove first line (```mermaid) and last line (```)
          const codeLines = lines.slice(1, -1);
          const code = codeLines.join("\n").trim();

          if (code) {
            blocks.push({
              code,
              blockFrom: node.from,
              blockTo: node.to,
              codeFrom,
              codeTo,
            });
          }
        }
      }
    },
  });

  return blocks;
}

// The block scan depends only on the document; memoize it so cursor movement
// reuses the scan instead of re-walking the tree.
const findMermaidBlocksCached = memoizeByParsedDoc(findMermaidBlocks);

function buildMermaidDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;
  const blocks = findMermaidBlocksCached(state);

  for (const block of blocks) {
    const isEditing = cursorInNode(
      cursor.from,
      cursor.to,
      block.blockFrom,
      block.blockTo,
    );

    if (isEditing) {
      // Add line decoration to each line so the class lands on .cm-line elements
      const startLine = state.doc.lineAt(block.blockFrom).number;
      const endLine = state.doc.lineAt(block.blockTo).number;
      for (let ln = startLine; ln <= endLine; ln++) {
        const line = state.doc.line(ln);
        decorations.push(
          Decoration.line({
            class: "cm-mermaid-editing",
          }).range(line.from),
        );
      }
    } else {
      // Replace with rendered diagram when not editing
      const widgetId = `${diagramIdCounter++}`;
      decorations.push(
        Decoration.replace({
          widget: new MermaidWidget(block.code, widgetId, block.blockFrom),
          block: true,
        }).range(block.blockFrom, block.blockTo),
      );
    }
  }

  return decorations;
}

const mermaidDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildMermaidDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || needsDecorationRebuild(tr)) {
      return RangeSet.of(buildMermaidDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * ViewPlugin to keep track of the current EditorView for click handling
 */
const mermaidViewPlugin = ViewPlugin.fromClass(
  class {
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      currentView = view;
    }

    update(_update: ViewUpdate) {
      // Keep the reference updated
      currentView = this.view;
    }

    destroy() {
      if (currentView === this.view) {
        currentView = null;
      }
    }
  },
);

/**
 * Combined mermaid plugin with decorations and view tracking
 */
export const mermaidPlugin = [mermaidDecorationField, mermaidViewPlugin];

/**
 * Clear the mermaid diagram cache
 */
export function clearMermaidCache(): void {
  diagramCache.clear();
}
