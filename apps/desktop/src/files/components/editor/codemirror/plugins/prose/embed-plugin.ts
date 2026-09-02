/**
 * Embed decoration plugin
 * Renders Obsidian-style embeds ![[file]] with preview
 *
 * Supports:
 * - ![[image.png]] - Image embeds (rendered as images)
 * - ![[note.md]] - Note embeds (rendered as preview cards)
 * - ![[note.md#section]] - Section embeds
 */

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
  type Extension,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { DecorationSet } from "@codemirror/view";
import {
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  PDF_EXTENSIONS,
  VIDEO_EXTENSIONS,
} from "@/files/media-types";
import { cursorInNode } from "../../utility/tools";

/**
 * Check if a position is inside a Blockquote (callout) node
 */
function isInsideCallout(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let insideCallout = false;

  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.name === "Blockquote") {
        if (node.from <= from && node.to >= to) {
          // Check if it's actually a callout (has [!type] syntax on first line)
          const firstLine = state.doc.lineAt(node.from);
          if (/^>\s*\[!([^\]]+)\]/.test(firstLine.text)) {
            insideCallout = true;
          }
        }
      }
    },
  });

  return insideCallout;
}

// Store view reference for click handling
let embedCurrentView: EditorView | null = null;

type EmbedType = "image" | "audio" | "video" | "pdf" | "note";

function getEmbedType(path: string): EmbedType {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (PDF_EXTENSIONS.has(ext)) return "pdf";
  return "note";
}

interface EmbedInfo {
  path: string;
  subpath: string;
  display: string;
  type: EmbedType;
  width?: number;
  height?: number;
}

/**
 * Parse embed modifiers like |100 or |100x200 or |alt text
 */
function parseModifier(display: string): {
  width?: number;
  height?: number;
  alt?: string;
} {
  if (!display) return {};

  const dimensionMatch = display.match(/^(\d+)(?:x(\d+))?$/);
  if (dimensionMatch) {
    return {
      width: parseInt(dimensionMatch[1], 10),
      height: dimensionMatch[2] ? parseInt(dimensionMatch[2], 10) : undefined,
    };
  }

  return { alt: display };
}

/**
 * Helper to add click handler for editing mode
 */
function addEmbedClickHandler(container: HTMLElement, nodeFrom: number): void {
  container.style.cursor = "pointer";
  container.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (embedCurrentView) {
      const view = embedCurrentView;
      view.dispatch({
        selection: { anchor: nodeFrom + 1 }, // Move cursor inside the embed syntax
        scrollIntoView: true,
      });
      view.focus();
    }
  });
}

/**
 * Widget for image embeds
 */
class ImageEmbedWidget extends WidgetType {
  constructor(
    private info: EmbedInfo,
    private getImageUrl: (path: string) => string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-embed cm-embed-image";

    // Add click handler to enter edit mode
    addEmbedClickHandler(container, this.nodeFrom);

    const img = document.createElement("img");
    img.src = this.getImageUrl(this.info.path);
    img.alt = this.info.display || this.info.path;
    img.loading = "lazy";

    if (this.info.width) {
      img.style.width = `${this.info.width}px`;
    }
    if (this.info.height) {
      img.style.height = `${this.info.height}px`;
    }

    img.onerror = () => {
      container.classList.add("cm-embed-error");
      container.textContent = `Failed to load: ${this.info.path}`;
    };

    container.appendChild(img);
    return container;
  }

  eq(other: ImageEmbedWidget): boolean {
    return (
      this.info.path === other.info.path &&
      this.info.width === other.info.width &&
      this.info.height === other.info.height &&
      this.nodeFrom === other.nodeFrom
    );
  }

  get estimatedHeight(): number {
    return this.info.height ?? 200;
  }
}

/**
 * Widget for note embeds
 */
class NoteEmbedWidget extends WidgetType {
  constructor(
    private info: EmbedInfo,
    private nodeFrom: number,
    private insideCallout: boolean = false,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = `cm-embed cm-embed-note${this.insideCallout ? " cm-embed-in-callout" : ""}`;

    // Add click handler to enter edit mode
    addEmbedClickHandler(container, this.nodeFrom);

    const header = document.createElement("div");
    header.className = "cm-embed-note-header";

    const icon = document.createElement("span");
    icon.className = "cm-embed-note-icon";
    icon.textContent = "📄";

    const title = document.createElement("span");
    title.className = "cm-embed-note-title";
    title.textContent = this.info.display || this.info.path;

    const link = document.createElement("span");
    link.className = "cm-embed-note-link";
    link.textContent = "↗";

    header.appendChild(icon);
    header.appendChild(title);
    header.appendChild(link);

    container.appendChild(header);

    if (this.info.subpath) {
      const subpath = document.createElement("div");
      subpath.className = "cm-embed-note-subpath";
      subpath.textContent = this.info.subpath;
      container.appendChild(subpath);
    }

    // Add a placeholder for content preview
    const preview = document.createElement("div");
    preview.className = "cm-embed-note-preview";
    preview.textContent = "Click to open...";
    container.appendChild(preview);

    return container;
  }

  eq(other: NoteEmbedWidget): boolean {
    return (
      this.info.path === other.info.path &&
      this.info.subpath === other.info.subpath &&
      this.nodeFrom === other.nodeFrom &&
      this.insideCallout === other.insideCallout
    );
  }

  get estimatedHeight(): number {
    return 80;
  }
}

/**
 * Widget for audio embeds
 */
class AudioEmbedWidget extends WidgetType {
  constructor(
    private info: EmbedInfo,
    private getAudioUrl: (path: string) => string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-embed cm-embed-audio";

    // Add click handler to enter edit mode
    addEmbedClickHandler(container, this.nodeFrom);

    const audio = document.createElement("audio");
    audio.src = this.getAudioUrl(this.info.path);
    audio.controls = true;
    audio.preload = "metadata";

    container.appendChild(audio);
    return container;
  }

  eq(other: AudioEmbedWidget): boolean {
    return (
      this.info.path === other.info.path && this.nodeFrom === other.nodeFrom
    );
  }
}

/**
 * Widget for video embeds
 */
class VideoEmbedWidget extends WidgetType {
  constructor(
    private info: EmbedInfo,
    private getVideoUrl: (path: string) => string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-embed cm-embed-video";

    // Add click handler to enter edit mode
    addEmbedClickHandler(container, this.nodeFrom);

    const video = document.createElement("video");
    video.src = this.getVideoUrl(this.info.path);
    video.controls = true;
    video.preload = "metadata";

    if (this.info.width) {
      video.style.width = `${this.info.width}px`;
    }
    if (this.info.height) {
      video.style.height = `${this.info.height}px`;
    }

    container.appendChild(video);
    return container;
  }

  eq(other: VideoEmbedWidget): boolean {
    return (
      this.info.path === other.info.path &&
      this.info.width === other.info.width &&
      this.info.height === other.info.height &&
      this.nodeFrom === other.nodeFrom
    );
  }
}

/**
 * Widget for PDF embeds
 */
class PdfEmbedWidget extends WidgetType {
  constructor(
    private info: EmbedInfo,
    private getPdfUrl: (path: string) => string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-embed cm-embed-pdf";

    // Add click handler to enter edit mode
    addEmbedClickHandler(container, this.nodeFrom);

    const header = document.createElement("div");
    header.className = "cm-embed-pdf-header";

    const icon = document.createElement("span");
    icon.className = "cm-embed-pdf-icon";
    icon.textContent = "📕";

    const title = document.createElement("span");
    title.className = "cm-embed-pdf-title";
    title.textContent = this.info.path;

    header.appendChild(icon);
    header.appendChild(title);
    container.appendChild(header);

    // For now, just show a link to open the PDF
    const link = document.createElement("a");
    link.className = "cm-embed-pdf-link";
    link.href = this.getPdfUrl(this.info.path);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open PDF";
    container.appendChild(link);

    return container;
  }

  eq(other: PdfEmbedWidget): boolean {
    return (
      this.info.path === other.info.path && this.nodeFrom === other.nodeFrom
    );
  }
}

/**
 * Extract embed information from an Embed node
 */
function extractEmbedInfo(
  state: EditorState,
  from: number,
  to: number,
): EmbedInfo | null {
  let path = "";
  let subpath = "";
  let display = "";

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (node.name === "InternalPath") {
        path = state.doc.sliceString(node.from, node.to);
      }
      if (node.name === "InternalSubpath") {
        subpath = state.doc.sliceString(node.from, node.to);
      }
      if (node.name === "InternalDisplay") {
        display = state.doc.sliceString(node.from, node.to);
      }
    },
  });

  if (!path) return null;

  const modifiers = parseModifier(display);
  const type = getEmbedType(path);

  return {
    path,
    subpath,
    display: modifiers.alt ?? display,
    type,
    width: modifiers.width,
    height: modifiers.height,
  };
}

export interface EmbedPluginConfig {
  getImageUrl: (path: string) => string;
  getAudioUrl?: (path: string) => string;
  getVideoUrl?: (path: string) => string;
  getPdfUrl?: (path: string) => string;
  onEmbedClick?: (path: string, type: EmbedType) => void;
}

function buildEmbedDecorations(
  state: EditorState,
  config: EmbedPluginConfig,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "Embed") {
        const isEditing = cursorInNode(
          cursor.from,
          cursor.to,
          node.from,
          node.to,
        );
        const embedInfo = extractEmbedInfo(state, node.from, node.to);

        if (!embedInfo) return;

        // Check if embed is inside a callout
        const insideCallout = isInsideCallout(state, node.from, node.to);

        if (isEditing) {
          // Show raw syntax when editing
          decorations.push(
            Decoration.mark({
              class: "cm-embed-editing",
            }).range(node.from, node.to),
          );
        } else {
          // Replace with widget when not editing
          let widget: WidgetType;
          const nodeFrom = node.from;

          switch (embedInfo.type) {
            case "image":
              widget = new ImageEmbedWidget(
                embedInfo,
                config.getImageUrl,
                nodeFrom,
              );
              break;
            case "audio":
              widget = new AudioEmbedWidget(
                embedInfo,
                config.getAudioUrl ?? config.getImageUrl,
                nodeFrom,
              );
              break;
            case "video":
              widget = new VideoEmbedWidget(
                embedInfo,
                config.getVideoUrl ?? config.getImageUrl,
                nodeFrom,
              );
              break;
            case "pdf":
              widget = new PdfEmbedWidget(
                embedInfo,
                config.getPdfUrl ?? config.getImageUrl,
                nodeFrom,
              );
              break;
            case "note":
            default:
              widget = new NoteEmbedWidget(embedInfo, nodeFrom, insideCallout);
              break;
          }

          // When inside a callout, render inline (block: false) to integrate with callout styling
          // Otherwise render as a block element
          decorations.push(
            Decoration.replace({
              widget,
              block: !insideCallout,
            }).range(node.from, node.to),
          );
        }
      }
    },
  });

  return decorations;
}

/**
 * ViewPlugin to keep track of the current EditorView for click handling
 */
const embedViewPlugin = ViewPlugin.fromClass(
  class {
    private view: EditorView;

    constructor(view: EditorView) {
      this.view = view;
      embedCurrentView = view;
    }

    update(_update: ViewUpdate) {
      // Keep the reference updated
      embedCurrentView = this.view;
    }

    destroy() {
      if (embedCurrentView === this.view) {
        embedCurrentView = null;
      }
    }
  },
);

/**
 * Create an embed plugin with the given configuration
 * Returns an array of extensions including the decoration field and view plugin
 */
export function createEmbedPlugin(config: EmbedPluginConfig): Extension {
  const decorationField = StateField.define<DecorationSet>({
    create(state) {
      return RangeSet.of(buildEmbedDecorations(state, config), true);
    },
    update(value, tr) {
      if (tr.docChanged || tr.selection || needsDecorationRebuild(tr)) {
        return RangeSet.of(buildEmbedDecorations(tr.state, config), true);
      }
      return value.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [decorationField, embedViewPlugin];
}

/**
 * Click handler for embeds
 */
export function createEmbedClickHandler(
  onEmbedClick: (path: string, type: EmbedType) => void,
) {
  return EditorView.domEventHandlers({
    click(event, _view) {
      const target = event.target as HTMLElement;
      const embedElement = target.closest(".cm-embed");

      if (embedElement) {
        // Find the path from data attributes or content
        const noteEmbed = embedElement.querySelector(".cm-embed-note-title");
        if (noteEmbed) {
          event.preventDefault();
          onEmbedClick(noteEmbed.textContent ?? "", "note");
          return true;
        }
      }

      return false;
    },
  });
}
