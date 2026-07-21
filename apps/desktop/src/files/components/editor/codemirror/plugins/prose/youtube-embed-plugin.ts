/**
 * YouTube embed decoration plugin
 * Renders YouTube URLs as embedded video players (like Obsidian)
 *
 * Supports:
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://www.youtube.com/embed/VIDEO_ID
 * - https://youtube.com/shorts/VIDEO_ID
 */

import { hasDecorationRefresh } from "../decoration-refresh";
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
import type { DecorationSet } from "@codemirror/view";
import { cursorInNode } from "../../utility/tools";

// Store view reference for edit button click handling
let youtubeCurrentView: EditorView | null = null;

/**
 * Regular expression to match YouTube URLs
 */
const YOUTUBE_URL_REGEX =
  /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[?&][^\s<>\[\]()"`'，。、！？；：""''（）【】「」]*)*/g;

/**
 * Extract YouTube video ID from URL
 */
function extractYouTubeVideoId(url: string): string | null {
  // youtube.com/watch?v=VIDEO_ID
  const watchMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (watchMatch) return watchMatch[1];

  // youtu.be/VIDEO_ID
  const shortMatch = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (shortMatch) return shortMatch[1];

  // youtube.com/embed/VIDEO_ID
  const embedMatch = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
  if (embedMatch) return embedMatch[1];

  // youtube.com/shorts/VIDEO_ID
  const shortsMatch = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (shortsMatch) return shortsMatch[1];

  return null;
}


/**
 * Widget for YouTube embeds
 */
class YouTubeEmbedWidget extends WidgetType {
  constructor(
    private videoId: string,
    private url: string,
    private nodeFrom: number,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const container = document.createElement("div");
    container.className = "cm-embed cm-embed-youtube";

    // Edit button (since iframe captures clicks)
    const editButton = document.createElement("button");
    editButton.className = "cm-embed-youtube-edit";
    editButton.type = "button";
    editButton.setAttribute("aria-label", "Edit");
    editButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`;
    editButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (youtubeCurrentView) {
        youtubeCurrentView.dispatch({
          selection: { anchor: this.nodeFrom + 1 },
          scrollIntoView: true,
        });
        youtubeCurrentView.focus();
      }
    });
    container.appendChild(editButton);

    // Wrapper for 16:9 aspect ratio
    const wrapper = document.createElement("div");
    wrapper.className = "cm-embed-youtube-wrapper";

    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube-nocookie.com/embed/${this.videoId}`;
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.allow =
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
    iframe.allowFullscreen = true;
    iframe.loading = "lazy";
    iframe.title = "YouTube video player";

    wrapper.appendChild(iframe);
    container.appendChild(wrapper);
    return container;
  }

  eq(other: YouTubeEmbedWidget): boolean {
    return (
      this.videoId === other.videoId &&
      this.url === other.url &&
      this.nodeFrom === other.nodeFrom
    );
  }

  get estimatedHeight(): number {
    return 315;
  }
}

/**
 * Find YouTube URLs in a line of text
 * Returns array of {from, to, url, videoId} objects with document positions
 */
function findYouTubeUrlsInLine(
  lineText: string,
  lineStart: number,
): Array<{ from: number; to: number; url: string; videoId: string }> {
  const results: Array<{
    from: number;
    to: number;
    url: string;
    videoId: string;
  }> = [];

  // Reset regex state
  YOUTUBE_URL_REGEX.lastIndex = 0;

  let match;
  while ((match = YOUTUBE_URL_REGEX.exec(lineText)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const url = match[0];

    // Check if this URL is inside markdown link syntax
    const beforeUrl = lineText.slice(0, matchStart);
    const afterUrl = lineText.slice(matchEnd);

    // Skip if inside [text](url)
    const lastParenOpen = beforeUrl.lastIndexOf("](");
    if (lastParenOpen !== -1) {
      const closingParen = afterUrl.indexOf(")");
      if (closingParen !== -1) {
        const betweenParenAndUrl = beforeUrl.slice(lastParenOpen + 2);
        if (!betweenParenAndUrl.includes(")")) {
          continue;
        }
      }
    }

    // Skip if inside <url> autolink syntax
    const lastAngleBracket = beforeUrl.lastIndexOf("<");
    if (lastAngleBracket !== -1) {
      const closingAngle = afterUrl.indexOf(">");
      const betweenAngleAndUrl = beforeUrl.slice(lastAngleBracket + 1);
      if (closingAngle !== -1 && !betweenAngleAndUrl.includes(">")) {
        continue;
      }
    }

    const videoId = extractYouTubeVideoId(url);
    if (videoId) {
      results.push({
        from: lineStart + matchStart,
        to: lineStart + matchEnd,
        url,
        videoId,
      });
    }
  }

  return results;
}

/**
 * Find all YouTube URLs in the document
 */
function findYouTubeUrls(
  state: EditorState,
): Array<{ from: number; to: number; url: string; videoId: string }> {
  const results: Array<{
    from: number;
    to: number;
    url: string;
    videoId: string;
  }> = [];

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    const lineUrls = findYouTubeUrlsInLine(line.text, line.from);
    results.push(...lineUrls);
  }

  return results;
}

function buildYouTubeEmbedDecorations(
  state: EditorState,
): EditorRange<Decoration>[] {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;

  const youtubeUrls = findYouTubeUrls(state);

  for (const { from, to, url, videoId } of youtubeUrls) {
    const isEditing = cursorInNode(cursor.from, cursor.to, from, to);

    if (isEditing) {
      // Show raw URL when editing
      decorations.push(
        Decoration.mark({
          class: "cm-youtube-editing",
        }).range(from, to),
      );
    } else {
      // Replace with YouTube embed widget
      const widget = new YouTubeEmbedWidget(videoId, url, from);

      decorations.push(
        Decoration.replace({
          widget,
          block: true,
        }).range(from, to),
      );
    }
  }

  return decorations;
}

/**
 * ViewPlugin to track the current EditorView for edit button
 */
const youtubeViewPlugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      youtubeCurrentView = view;
    }

    update(_update: ViewUpdate) {
      // View reference stays the same
    }

    destroy() {
      youtubeCurrentView = null;
    }
  },
);

/**
 * Create a YouTube embed plugin
 * Returns StateField and ViewPlugin extensions
 */
export function createYouTubeEmbedPlugin(): Extension {
  const decorationField = StateField.define<DecorationSet>({
    create(state) {
      return RangeSet.of(buildYouTubeEmbedDecorations(state), true);
    },
    update(value, tr) {
      if (tr.docChanged || tr.selection || hasDecorationRefresh(tr)) {
        return RangeSet.of(buildYouTubeEmbedDecorations(tr.state), true);
      }
      return value.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return [decorationField, youtubeViewPlugin];
}
