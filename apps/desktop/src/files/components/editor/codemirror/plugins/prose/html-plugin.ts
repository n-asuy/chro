/**
 * HTML rendering plugin for WYSIWYG markdown editor
 *
 * Renders raw HTML embedded in markdown, including foreign content:
 * - Block-level HTML: <div>, <details>, <table>, etc.
 * - Vector graphics: <svg> with its full element/attribute vocabulary
 * - Formulas: <math> (MathML)
 * - Inline HTML: <span>, <mark>, <sub>, <sup>, etc.
 * - Self-closing tags: <br>, <hr>, <img>, etc.
 */

import { syntaxTree } from "@codemirror/language";
import {
  type Range as EditorRange,
  type EditorState,
  RangeSet,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import DOMPurify from "dompurify";
import { cursorInNode } from "../../utility/tools";
import { memoizeByDoc } from "../decoration-cache";
import { hasDecorationRefresh } from "../decoration-refresh";

// Store view reference for click handling
let currentView: EditorView | null = null;

/**
 * Sanitizer policy.
 *
 * The SVG and MathML profiles are what make diagrams work: their element and
 * attribute vocabularies (<rect>, <path>, `viewBox`, `stroke-width`, ...) have
 * nothing in common with HTML's, so an HTML-only allowlist silently reduces a
 * diagram to an empty <svg> box.
 *
 * `RETURN_DOM_FRAGMENT` hands back nodes instead of a string. Serializing a
 * sanitized tree and re-parsing it is the classic mutation-XSS setup, since the
 * second parse can reinterpret markup the first parse considered inert.
 */
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  // Embedded players and outbound links are long-standing note content, and
  // neither <iframe> nor `target` is in the default profile. Restored by name
  // so the exception stays visible instead of widening the whole policy.
  ADD_TAGS: ["iframe"],
  ADD_ATTR: [
    "target",
    "allow",
    "allowfullscreen",
    "frameborder",
    "loading",
    "referrerpolicy",
  ],
  RETURN_DOM_FRAGMENT: true as const,
};

function sanitizeToFragment(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

/**
 * Tags that occupy their own block when rendered. Used only to decide between
 * a block widget and an inline widget; it carries no security meaning.
 */
const BLOCK_LEVEL_TAGS = new Set([
  "address",
  "article",
  "aside",
  "audio",
  "blockquote",
  "canvas",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "header",
  "iframe",
  "legend",
  "li",
  "main",
  "math",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "svg",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
  "video",
]);

/**
 * Widget to display rendered HTML block
 */
class HtmlBlockWidget extends WidgetType {
  constructor(
    private html: string,
    private blockFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-html-block-container";
    container.style.cursor = "pointer";

    container.appendChild(sanitizeToFragment(this.html));

    // Add click handler to edit
    const blockFrom = this.blockFrom;
    container.addEventListener("click", (event) => {
      // Don't intercept clicks on interactive elements
      const target = event.target as HTMLElement;
      if (
        target.tagName === "A" ||
        target.tagName === "BUTTON" ||
        target.tagName === "INPUT" ||
        target.tagName === "SELECT" ||
        target.tagName === "TEXTAREA" ||
        target.closest("a") ||
        target.closest("button")
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (currentView) {
        currentView.dispatch({
          selection: { anchor: blockFrom },
          scrollIntoView: true,
        });
        currentView.focus();
      }
    });

    return container;
  }

  eq(other: HtmlBlockWidget): boolean {
    return this.html === other.html && this.blockFrom === other.blockFrom;
  }

  get estimatedHeight(): number {
    return estimateBlockHeight(this.html);
  }
}

/**
 * Widget to display rendered inline HTML
 */
class HtmlInlineWidget extends WidgetType {
  constructor(
    private html: string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("span");
    container.className = "cm-html-inline-container";

    container.appendChild(sanitizeToFragment(this.html));

    return container;
  }

  eq(other: HtmlInlineWidget): boolean {
    return this.html === other.html && this.nodeFrom === other.nodeFrom;
  }
}

interface HtmlBlockInfo {
  html: string;
  from: number;
  to: number;
  isBlock: boolean;
}

/**
 * Check if HTML content is block-level.
 *
 * Closing tags count too. A tag pair is skipped or rendered as a unit, and
 * matching only `<tag>` would leave the orphaned `</tag>` to be replaced by an
 * empty inline widget, silently hiding it from the source.
 */
function isBlockLevelHtml(html: string): boolean {
  const trimmed = html.trim();
  const match = trimmed.match(/^<\/?(\w+)/);
  if (!match) return false;

  const tagName = match[1].toLowerCase();
  return BLOCK_LEVEL_TAGS.has(tagName);
}

/**
 * Width the editor's content column is assumed to have while a block is still
 * unmeasured. Only used to turn an SVG aspect ratio into a pixel estimate.
 */
const NOMINAL_CONTENT_WIDTH = 700;

/** Height assumed for HTML with no declared geometry. */
const DEFAULT_BLOCK_HEIGHT = 50;

function readAttribute(openingTag: string, name: string): string | null {
  const match = openingTag.match(
    new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"),
  );
  return match ? match[2] ?? match[3] ?? null : null;
}

/** Parse a length that resolves to pixels; `100%` and friends do not. */
function parsePixelLength(value: string | null): number | null {
  if (value === null) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(px)?$/i);
  if (!match) return null;
  const pixels = Number.parseFloat(match[1]);
  return pixels > 0 ? pixels : null;
}

/**
 * Estimate a block's rendered height before it has been measured.
 *
 * CodeMirror sizes the scrollbar and the viewport from this number, so an
 * estimate far below the real height makes the document shift under the reader
 * once the block is measured. A diagram declaring `viewBox="0 0 1000 300"` is
 * several hundred pixels tall, not the 50px an unspecified block gets.
 */
function estimateBlockHeight(html: string): number {
  const openingTag = html.match(/<svg\b[^>]*>/i)?.[0];
  if (!openingTag) return DEFAULT_BLOCK_HEIGHT;

  const declaredHeight = parsePixelLength(readAttribute(openingTag, "height"));
  if (declaredHeight !== null) return declaredHeight;

  const viewBox = readAttribute(openingTag, "viewBox")
    ?.trim()
    .split(/[\s,]+/);
  if (viewBox?.length === 4) {
    const width = Number.parseFloat(viewBox[2]);
    const height = Number.parseFloat(viewBox[3]);
    if (width > 0 && height > 0) {
      return Math.round(NOMINAL_CONTENT_WIDTH * (height / width));
    }
  }

  return DEFAULT_BLOCK_HEIGHT;
}

/**
 * Find HTML blocks and inline HTML in the syntax tree
 */
function findHtmlContent(state: EditorState): HtmlBlockInfo[] {
  const htmlContent: HtmlBlockInfo[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      // HTMLBlock is a block-level HTML element
      if (node.name === "HTMLBlock") {
        const html = state.doc.sliceString(node.from, node.to);
        if (html.trim()) {
          htmlContent.push({
            html,
            from: node.from,
            to: node.to,
            isBlock: true,
          });
        }
      }

      // HTMLTag handles inline HTML
      if (node.name === "HTMLTag") {
        const html = state.doc.sliceString(node.from, node.to);
        if (html.trim() && !isBlockLevelHtml(html)) {
          htmlContent.push({
            html,
            from: node.from,
            to: node.to,
            isBlock: false,
          });
        }
      }
    },
  });

  return htmlContent;
}

// The scan depends only on the document; memoize it so moving the cursor
// reuses the scan instead of re-walking the syntax tree.
const findHtmlContentCached = memoizeByDoc(findHtmlContent);

/**
 * Build decorations for HTML content
 */
function buildHtmlDecorations(state: EditorState): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;
  const htmlContent = findHtmlContentCached(state);

  for (const content of htmlContent) {
    const isEditing = cursorInNode(
      cursor.from,
      cursor.to,
      content.from,
      content.to,
    );

    if (isEditing) {
      // Show raw HTML when editing
      decorations.push(
        Decoration.mark({
          class: content.isBlock
            ? "cm-html-block-editing"
            : "cm-html-inline-editing",
        }).range(content.from, content.to),
      );
    } else {
      if (content.isBlock) {
        // Replace with rendered HTML block
        decorations.push(
          Decoration.replace({
            widget: new HtmlBlockWidget(content.html, content.from),
            block: true,
          }).range(content.from, content.to),
        );
      } else {
        // Replace with rendered inline HTML
        decorations.push(
          Decoration.replace({
            widget: new HtmlInlineWidget(content.html, content.from),
          }).range(content.from, content.to),
        );
      }
    }
  }

  return decorations;
}

const htmlDecorationField = StateField.define<DecorationSet>({
  create(state) {
    return RangeSet.of(buildHtmlDecorations(state), true);
  },
  update(value, tr) {
    if (tr.docChanged || tr.selection || hasDecorationRefresh(tr)) {
      return RangeSet.of(buildHtmlDecorations(tr.state), true);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * ViewPlugin to keep track of the current EditorView for click handling
 */
const htmlViewPlugin = ViewPlugin.fromClass(
  class {
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      currentView = view;
    }

    update(_update: ViewUpdate) {
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
 * Combined HTML plugin with decorations and view tracking
 */
export const htmlPlugin = [htmlDecorationField, htmlViewPlugin];
