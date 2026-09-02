/**
 * External link decoration plugin
 * Adds styling and click handling to:
 * - [text](https://example.com) - inline links
 * - [text][ref] - reference links
 * - <https://example.com> - autolinks
 * - https://example.com - bare URLs (like Obsidian)
 * In live preview mode, displays only the link text when not editing
 */

import { openExternalUrl } from "@/lib/open-external-url";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range as EditorRange } from "@codemirror/state";
import { cursorInNode } from "../../utility/tools";
import { createProsePlugin } from "./create-prose-plugin";

/**
 * Widget to display external link icon
 */
class ExternalLinkIconWidget extends WidgetType {
  constructor() {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-external-link-icon";
    span.textContent = "↗";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  eq(): boolean {
    return true;
  }
}

const normalizeExternalUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized =
    trimmed.startsWith("<") && trimmed.endsWith(">")
      ? trimmed.slice(1, -1)
      : trimmed;
  const lower = normalized.toLowerCase();
  if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
    return null;
  }

  return normalized;
};

const extractLinkDestination = (
  state: EditorState,
  from: number,
  to: number,
): string => {
  let linkDestination = "";

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (
        node.name === "LinkDestination" ||
        node.name === "URL" ||
        node.name === "LinkURL"
      ) {
        linkDestination = state.doc.sliceString(node.from, node.to);
      }
    },
  });

  if (!linkDestination) {
    const linkText = state.doc.sliceString(from, to);
    const match = linkText.match(/\]\(([^)\s]+)\)/);
    if (match?.[1]) {
      linkDestination = match[1];
    }
  }

  return linkDestination;
};

/**
 * Extract the display text from a Link node
 * The display text is the content between [ and ]
 */
/**
 * Extract the display text from a Link node
 * The display text is the content between [ and ]
 */
const extractLinkText = (
  state: EditorState,
  from: number,
  to: number,
): { text: string; textFrom: number; textTo: number } | null => {
  const fullText = state.doc.sliceString(from, to);
  // Match [text](url) pattern
  const match = fullText.match(/^\[([^\]]*)\]\(/);
  if (!match) {
    return null;
  }

  const text = match[1];
  // Skip the opening [
  const textFrom = from + 1;
  const textTo = textFrom + text.length;

  return { text, textFrom, textTo };
};

/**
 * Extract the display text from a LinkReference node
 * Format: [text][ref] or [text][]
 */
const extractReferenceLinkText = (
  state: EditorState,
  from: number,
  to: number,
): { text: string; textFrom: number; textTo: number; ref: string } | null => {
  const fullText = state.doc.sliceString(from, to);
  // Match [text][ref] or [text][] pattern
  const match = fullText.match(/^\[([^\]]*)\]\[([^\]]*)\]$/);
  if (!match) {
    return null;
  }

  const text = match[1];
  const ref = match[2] || match[1]; // If ref is empty, use text as ref
  const textFrom = from + 1;
  const textTo = textFrom + text.length;

  return { text, textFrom, textTo, ref };
};

/**
 * Build a map of link reference definitions from the document
 * Format: [ref]: url "optional title"
 */
const buildLinkReferenceMap = (
  state: EditorState,
): Map<string, string> => {
  const refMap = new Map<string, string>();

  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === "LinkReference") {
        // This is [ref]: url format
        const text = state.doc.sliceString(node.from, node.to);
        // Match [ref]: url pattern
        const match = text.match(/^\[([^\]]+)\]:\s*(\S+)/);
        if (match) {
          const ref = match[1].toLowerCase();
          const url = match[2];
          refMap.set(ref, url);
        }
      }
    },
  });

  return refMap;
};

/**
 * Regular expression to match bare URLs (not inside markdown syntax)
 * Matches http:// and https:// URLs
 */
const BARE_URL_REGEX =
  /https?:\/\/[^\s<>\[\]()"`'，。、！？；：""''（）【】「」]*[^\s<>\[\]()"`'，。、！？；：""''（）【】「」.,;:!?)]/g;

/**
 * Find bare URLs in a line of text that are not part of markdown link syntax
 * Returns array of {from, to, url} objects with document positions
 */
const findBareUrlsInLine = (
  lineText: string,
  lineStart: number,
): Array<{ from: number; to: number; url: string }> => {
  const results: Array<{ from: number; to: number; url: string }> = [];

  // Reset regex state
  BARE_URL_REGEX.lastIndex = 0;

  let match;
  while ((match = BARE_URL_REGEX.exec(lineText)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    // Check if this URL is inside markdown link syntax
    // Look for ]( before the URL on the same line (inline link destination)
    const beforeUrl = lineText.slice(0, matchStart);
    const afterUrl = lineText.slice(matchEnd);

    // Skip if inside [text](url) - check for ]( before and ) after
    const lastParenOpen = beforeUrl.lastIndexOf("](");
    if (lastParenOpen !== -1) {
      const closingParen = afterUrl.indexOf(")");
      if (closingParen !== -1) {
        // Check if there's no ) between ]( and the URL
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

    // Skip if this is part of a link reference definition [ref]: url
    if (/\[[^\]]+\]:\s*$/.test(beforeUrl)) {
      continue;
    }

    results.push({
      from: lineStart + matchStart,
      to: lineStart + matchEnd,
      url: match[0],
    });
  }

  return results;
};

/**
 * Find all bare URLs in the document that should be decorated
 */
const findBareUrls = (
  state: EditorState,
  existingLinkRanges: Set<string>,
): Array<{ from: number; to: number; url: string }> => {
  const results: Array<{ from: number; to: number; url: string }> = [];

  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    const lineUrls = findBareUrlsInLine(line.text, line.from);

    for (const urlInfo of lineUrls) {
      // Skip if this range overlaps with an existing markdown link
      const rangeKey = `${urlInfo.from}-${urlInfo.to}`;
      if (existingLinkRanges.has(rangeKey)) {
        continue;
      }

      // Also check if any part of this URL is inside an existing link range
      let overlaps = false;
      for (const key of existingLinkRanges) {
        const [existingFrom, existingTo] = key.split("-").map(Number);
        if (urlInfo.from < existingTo && urlInfo.to > existingFrom) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        results.push(urlInfo);
      }
    }
  }

  return results;
};

const buildExternalLinkDecorations = (
  state: EditorState,
): EditorRange<Decoration>[] => {
  const decorations: EditorRange<Decoration>[] = [];
  const cursor = state.selection.main;

  // Build reference map for resolving [text][ref] links
  const refMap = buildLinkReferenceMap(state);

  // Track ranges that are already part of markdown link syntax
  const existingLinkRanges = new Set<string>();

  syntaxTree(state).iterate({
    enter(node) {
      // Handle reference links [text][ref]
      if (node.name === "LinkReference") {
        const text = state.doc.sliceString(node.from, node.to);

        // Skip link definitions [ref]: url
        if (text.includes("]:")) {
          return;
        }

        const refLinkInfo = extractReferenceLinkText(state, node.from, node.to);
        if (!refLinkInfo || refLinkInfo.text === "") {
          return;
        }

        // Try to resolve the reference to a URL
        const url = refMap.get(refLinkInfo.ref.toLowerCase());

        const isEditing = cursorInNode(
          cursor.from,
          cursor.to,
          node.from,
          node.to,
        );
        const classes = ["cm-clickable-link", "cm-reference-link"];
        if (isEditing) {
          classes.push("cm-reference-link-editing");
        }

        // Track this range to exclude from bare URL detection
        existingLinkRanges.add(`${node.from}-${node.to}`);

        // Add the base link decoration
        decorations.push(
          Decoration.mark({
            class: classes.join(" "),
            attributes: {
              "data-link-ref": refLinkInfo.ref,
              ...(url ? { "data-link-url": url, title: url } : {}),
            },
          }).range(node.from, node.to),
        );

        // When not editing, hide the markdown syntax and show only text
        if (!isEditing) {
          // Hide the opening [ bracket
          decorations.push(
            Decoration.replace({
              class: "cm-reference-link-hidden",
            }).range(node.from, refLinkInfo.textFrom),
          );

          // Hide everything after the link text: ][ref]
          decorations.push(
            Decoration.replace({
              class: "cm-reference-link-hidden",
            }).range(refLinkInfo.textTo, node.to),
          );

          // Add icon widget after the link
          decorations.push(
            Decoration.widget({
              widget: new ExternalLinkIconWidget(),
              side: 1,
            }).range(node.to),
          );
        }

        return;
      }

      // Handle inline links [text](url) and autolinks <url>
      if (node.name !== "Link" && node.name !== "Autolink") {
        return;
      }

      const rawUrl =
        node.name === "Autolink"
          ? state.doc.sliceString(node.from, node.to)
          : extractLinkDestination(state, node.from, node.to);
      const url = normalizeExternalUrl(rawUrl);

      if (!url) {
        return;
      }

      // Track this range to exclude from bare URL detection
      existingLinkRanges.add(`${node.from}-${node.to}`);

      const isEditing = cursorInNode(
        cursor.from,
        cursor.to,
        node.from,
        node.to,
      );
      const classes = ["cm-clickable-link", "cm-external-link"];
      if (isEditing) {
        classes.push("cm-external-link-editing");
      }

      // Add the base link decoration for the entire node
      decorations.push(
        Decoration.mark({
          class: classes.join(" "),
          attributes: {
            "data-link-url": url,
            title: url,
          },
        }).range(node.from, node.to),
      );

      // When not editing a regular Link (not Autolink), hide the markdown syntax
      if (!isEditing && node.name === "Link") {
        const linkTextInfo = extractLinkText(state, node.from, node.to);

        if (linkTextInfo && linkTextInfo.text !== "") {
          // Hide the opening [ bracket
          decorations.push(
            Decoration.replace({
              class: "cm-external-link-hidden",
            }).range(node.from, linkTextInfo.textFrom),
          );

          // Hide everything after the link text: ](url)
          decorations.push(
            Decoration.replace({
              class: "cm-external-link-hidden",
            }).range(linkTextInfo.textTo, node.to),
          );

          // Add icon widget after the link
          decorations.push(
            Decoration.widget({
              widget: new ExternalLinkIconWidget(),
              side: 1,
            }).range(node.to),
          );
        }
      }
    },
  });

  // Find and decorate bare URLs (like Obsidian)
  const bareUrls = findBareUrls(state, existingLinkRanges);
  for (const { from, to, url } of bareUrls) {
    const isEditing = cursorInNode(cursor.from, cursor.to, from, to);
    const classes = ["cm-clickable-link", "cm-external-link", "cm-bare-url"];
    if (isEditing) {
      classes.push("cm-external-link-editing");
    }

    decorations.push(
      Decoration.mark({
        class: classes.join(" "),
        attributes: {
          "data-link-url": url,
          title: url,
        },
      }).range(from, to),
    );
  }

  return decorations;
};

export const externalLinkPlugin = createProsePlugin({
  buildDecorations: buildExternalLinkDecorations,
  rebuildOnDocChange: true,
  rebuildOnSelection: true,
});

/**
 * Click handler for external links
 * Mirrors Obsidian's "single-click to open" behavior.
 * - Plain left click follows the link.
 * - Holding Ctrl/Cmd while clicking keeps the default editing behavior.
 */
export function createExternalLinkClickHandler(
  onLinkClick: ((url: string) => void) | null = null,
) {
  return EditorView.domEventHandlers({
    mousedown(event) {
      const target = event.target instanceof Element ? event.target : null;
      const linkElement = target?.closest(".cm-external-link");

      if (!linkElement || event.defaultPrevented) {
        return false;
      }

      if (linkElement.classList.contains("cm-external-link-editing")) {
        return false;
      }

      const linkUrl = linkElement.getAttribute("data-link-url");
      if (!linkUrl) {
        return false;
      }

      const isPrimaryButton = event.button === 0;
      const hasNavigationModifiers =
        !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

      if (isPrimaryButton && hasNavigationModifiers) {
        event.preventDefault();
        event.stopPropagation();
        const handler = onLinkClick ?? openExternalUrl;
        handler(linkUrl);
        return true;
      }

      return false;
    },
  });
}
