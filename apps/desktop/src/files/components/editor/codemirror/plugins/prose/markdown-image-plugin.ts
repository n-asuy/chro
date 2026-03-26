/**
 * Standard Markdown image decoration plugin
 * Renders ![alt](url) images with live preview
 * In live preview mode, displays the image when not editing
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
  type Extension,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import { cursorInNode } from "../../utility/tools";

// Store view reference for click handling
let imageCurrentView: EditorView | null = null;

interface ImageInfo {
  alt: string;
  url: string;
  title?: string;
}

/**
 * Extract image information from an Image node
 * Format: ![alt](url "title")
 */
function extractImageInfo(
  state: EditorState,
  from: number,
  to: number,
): ImageInfo | null {
  const text = state.doc.sliceString(from, to);

  // Match ![alt](url) or ![alt](url "title")
  const match = text.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
  if (!match) {
    return null;
  }

  return {
    alt: match[1],
    url: match[2],
    title: match[3],
  };
}

/**
 * Check if URL is external (http/https)
 */
function isExternalUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("http://") || lower.startsWith("https://");
}

/**
 * Widget for markdown image preview
 */
class MarkdownImageWidget extends WidgetType {
  constructor(
    private info: ImageInfo,
    private resolveUrl: (url: string) => string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-markdown-image";

    // Add click handler to enter edit mode
    container.style.cursor = "pointer";
    container.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (imageCurrentView) {
        const view = imageCurrentView;
        view.dispatch({
          selection: { anchor: this.nodeFrom + 1 },
          scrollIntoView: true,
        });
        view.focus();
      }
    });

    const img = document.createElement("img");
    img.src = isExternalUrl(this.info.url)
      ? this.info.url
      : this.resolveUrl(this.info.url);
    img.alt = this.info.alt || this.info.url;
    if (this.info.title) {
      img.title = this.info.title;
    }
    img.loading = "lazy";

    img.onerror = () => {
      container.classList.add("cm-markdown-image-error");
      container.textContent = `Failed to load: ${this.info.url}`;
    };

    container.appendChild(img);
    return container;
  }

  eq(other: MarkdownImageWidget): boolean {
    return (
      this.info.url === other.info.url &&
      this.info.alt === other.info.alt &&
      this.nodeFrom === other.nodeFrom
    );
  }

  get estimatedHeight(): number {
    return 200;
  }
}

export interface MarkdownImagePluginConfig {
  resolveUrl: (path: string) => string;
}

function buildMarkdownImageDecorations(
  state: EditorState,
  config: MarkdownImagePluginConfig,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Image") {
        return;
      }

      const imageInfo = extractImageInfo(state, node.from, node.to);
      if (!imageInfo) {
        return;
      }

      const isEditing = cursorInNode(
        cursor.from,
        cursor.to,
        node.from,
        node.to,
      );

      if (isEditing) {
        // Show raw syntax when editing
        decorations.push(
          Decoration.mark({
            class: "cm-markdown-image-editing",
          }).range(node.from, node.to),
        );
      } else {
        // Replace with image widget when not editing
        decorations.push(
          Decoration.replace({
            widget: new MarkdownImageWidget(
              imageInfo,
              config.resolveUrl,
              node.from,
            ),
            block: true,
          }).range(node.from, node.to),
        );
      }
    },
  });

  return decorations;
}

/**
 * ViewPlugin to keep track of the current EditorView for click handling
 */
const imageViewPlugin = ViewPlugin.fromClass(
  class {
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      imageCurrentView = view;
    }

    update(_update: ViewUpdate) {
      imageCurrentView = this.view;
    }

    destroy() {
      if (imageCurrentView === this.view) {
        imageCurrentView = null;
      }
    }
  },
);

/**
 * Create a markdown image plugin with the given configuration
 */
export function createMarkdownImagePlugin(
  config: MarkdownImagePluginConfig,
): Extension {
  const decorationField = StateField.define<DecorationSet>({
    create(state) {
      return RangeSet.of(buildMarkdownImageDecorations(state, config), true);
    },
    update(value, tr) {
      if (tr.docChanged || tr.selection || tr.effects.length > 0) {
        return RangeSet.of(
          buildMarkdownImageDecorations(tr.state, config),
          true,
        );
      }
      return value.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [decorationField, imageViewPlugin];
}
