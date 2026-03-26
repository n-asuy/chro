/**
 * HTML rendering plugin for WYSIWYG markdown editor
 * Renders HTML blocks and inline HTML like Obsidian
 *
 * Supports:
 * - Block-level HTML: <div>, <details>, <table>, etc.
 * - Inline HTML: <span>, <mark>, <sub>, <sup>, etc.
 * - Self-closing tags: <br>, <hr>, <img>, etc.
 */

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

// Store view reference for click handling
let currentView: EditorView | null = null;

/**
 * Allowed HTML tags for security (similar to Obsidian)
 */
const ALLOWED_BLOCK_TAGS = new Set([
  "div",
  "p",
  "details",
  "summary",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "nav",
  "main",
  "figure",
  "figcaption",
  "blockquote",
  "pre",
  "address",
  "dl",
  "dt",
  "dd",
  "ol",
  "ul",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  "form",
  "fieldset",
  "legend",
  "label",
  "input",
  "button",
  "select",
  "option",
  "optgroup",
  "textarea",
  "output",
  "progress",
  "meter",
  "iframe",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "svg",
  "math",
  "center",
]);

const ALLOWED_INLINE_TAGS = new Set([
  "span",
  "a",
  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "ruby",
  "rt",
  "rp",
  "s",
  "samp",
  "small",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
  "img",
  "hr",
]);

/**
 * Dangerous attributes that should be removed
 */
const DANGEROUS_ATTRS = new Set([
  "onabort",
  "onafterprint",
  "onbeforeprint",
  "onbeforeunload",
  "onblur",
  "oncanplay",
  "oncanplaythrough",
  "onchange",
  "onclick",
  "oncontextmenu",
  "oncopy",
  "oncuechange",
  "oncut",
  "ondblclick",
  "ondrag",
  "ondragend",
  "ondragenter",
  "ondragleave",
  "ondragover",
  "ondragstart",
  "ondrop",
  "ondurationchange",
  "onemptied",
  "onended",
  "onerror",
  "onfocus",
  "onhashchange",
  "oninput",
  "oninvalid",
  "onkeydown",
  "onkeypress",
  "onkeyup",
  "onload",
  "onloadeddata",
  "onloadedmetadata",
  "onloadstart",
  "onmessage",
  "onmousedown",
  "onmousemove",
  "onmouseout",
  "onmouseover",
  "onmouseup",
  "onmousewheel",
  "onoffline",
  "ononline",
  "onpagehide",
  "onpageshow",
  "onpaste",
  "onpause",
  "onplay",
  "onplaying",
  "onpopstate",
  "onprogress",
  "onratechange",
  "onreset",
  "onresize",
  "onscroll",
  "onseeked",
  "onseeking",
  "onselect",
  "onstalled",
  "onstorage",
  "onsubmit",
  "onsuspend",
  "ontimeupdate",
  "onunload",
  "onvolumechange",
  "onwaiting",
  "onwheel",
]);

/**
 * Sanitize HTML content for safe rendering
 */
function sanitizeHtml(html: string): string {
  // Create a temporary container to parse HTML
  const template = document.createElement("template");
  template.innerHTML = html;

  const fragment = template.content;

  // Process all elements
  const processElement = (element: Element): void => {
    const tagName = element.tagName.toLowerCase();

    // Check if tag is allowed
    if (!ALLOWED_BLOCK_TAGS.has(tagName) && !ALLOWED_INLINE_TAGS.has(tagName)) {
      // Replace disallowed element with its text content
      const text = document.createTextNode(element.textContent || "");
      element.parentNode?.replaceChild(text, element);
      return;
    }

    // Remove dangerous attributes
    const attrs = Array.from(element.attributes);
    for (const attr of attrs) {
      const attrName = attr.name.toLowerCase();
      if (
        DANGEROUS_ATTRS.has(attrName) ||
        attrName.startsWith("on") ||
        (attrName === "href" &&
          attr.value.toLowerCase().startsWith("javascript:")) ||
        (attrName === "src" &&
          attr.value.toLowerCase().startsWith("javascript:"))
      ) {
        element.removeAttribute(attr.name);
      }
    }

    // Process children recursively
    const children = Array.from(element.children);
    for (const child of children) {
      processElement(child);
    }
  };

  // Process all top-level elements
  const elements = Array.from(fragment.children);
  for (const element of elements) {
    processElement(element);
  }

  // Serialize back to HTML
  const serializer = document.createElement("div");
  serializer.appendChild(fragment.cloneNode(true));
  return serializer.innerHTML;
}

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

    // Sanitize and render HTML
    const sanitized = sanitizeHtml(this.html);
    container.innerHTML = sanitized;

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
    return 50;
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

    // Sanitize and render HTML
    const sanitized = sanitizeHtml(this.html);
    container.innerHTML = sanitized;

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
 * Check if HTML content is block-level
 */
function isBlockLevelHtml(html: string): boolean {
  const trimmed = html.trim();
  const match = trimmed.match(/^<(\w+)/);
  if (!match) return false;

  const tagName = match[1].toLowerCase();
  return ALLOWED_BLOCK_TAGS.has(tagName);
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

/**
 * Build decorations for HTML content
 */
function buildHtmlDecorations(state: EditorState): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;
  const htmlContent = findHtmlContent(state);

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
    if (tr.docChanged || tr.selection || tr.effects.length > 0) {
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
