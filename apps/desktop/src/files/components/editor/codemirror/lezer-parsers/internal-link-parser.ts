/**
 * Internal link parser for Obsidian-style links ([[link]])
 * Based on lezer-markdown-obsidian
 */

import type { MarkdownConfig, InlineContext, Element } from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

export const lezerHighlightEmbed = Tag.define("Embed");
export const lezerHighlightEmbedMark = Tag.define("EmbedMark");
export const lezerHighlightInternalLink = Tag.define("InternalLink");
export const lezerHighlightInternalMark = Tag.define(
  "InternalMark",
  lezerHighlightInternalLink,
);
export const lezerHighlightInternalPath = Tag.define(
  "InternalPath",
  lezerHighlightInternalLink,
);
export const lezerHighlightInternalSubpath = Tag.define(
  "InternalSubpath",
  lezerHighlightInternalLink,
);
export const lezerHighlightInternalDisplay = Tag.define(
  "InternalDisplay",
  lezerHighlightInternalLink,
);

function parseInternalLink(cx: InlineContext, pos: number): Element | null {
  // Check for "[["
  if (cx.char(pos) !== 91 /* [ */ || cx.char(pos + 1) !== 91 /* [ */) {
    return null;
  }

  // Check if it's properly closed with "]]"
  let endMarkerPos = -1;
  for (let i = pos + 2; i < cx.end - 1; i++) {
    if (cx.char(i) === 93 /* ] */ && cx.char(i + 1) === 93 /* ] */) {
      // Avoid empty links like [[]]
      if (i === pos + 2) return null;
      endMarkerPos = i;
      break;
    }
    // Disallow nested "[["
    if (cx.char(i) === 91 /* [ */ && cx.char(i + 1) === 91 /* [ */) {
      return null;
    }
  }
  if (endMarkerPos === -1) return null;

  const children: Element[] = [];
  children.push(cx.elt("InternalMark", pos, pos + 2)); // Start "[["
  let currentPos = pos + 2;

  // Try to parse path (link target)
  let pathEnd = endMarkerPos;
  const pipePos = cx.slice(currentPos, endMarkerPos).indexOf("|");
  if (pipePos !== -1) {
    pathEnd = currentPos + pipePos;
  }

  const pathText = cx.slice(currentPos, pathEnd).trim();
  if (pathText.length > 0) {
    // Path can contain subpath, split it
    const hashPos = pathText.indexOf("#");
    if (hashPos !== -1) {
      const mainPath = pathText.substring(0, hashPos);
      const subPath = pathText.substring(hashPos); // Includes "#"

      if (mainPath.length > 0) {
        children.push(
          cx.elt("InternalPath", currentPos, currentPos + mainPath.length),
        );
      }
      if (subPath.length > 0) {
        children.push(
          cx.elt(
            "InternalSubpath",
            currentPos + mainPath.length,
            currentPos + pathText.length,
          ),
        );
      }
    } else {
      children.push(
        cx.elt("InternalPath", currentPos, currentPos + pathText.length),
      );
    }
  }
  currentPos = pathEnd;

  // Try to parse display text (alias) if there's a pipe
  if (pipePos !== -1 && currentPos < endMarkerPos) {
    children.push(cx.elt("InternalMark", currentPos, currentPos + 1)); // "|"
    currentPos += 1; // Move past "|"
    const displayText = cx.slice(currentPos, endMarkerPos).trim();
    if (displayText.length > 0) {
      children.push(
        cx.elt("InternalDisplay", currentPos, currentPos + displayText.length),
      );
    }
    currentPos += displayText.length;
  }

  // Add the closing "]]"
  children.push(cx.elt("InternalMark", endMarkerPos, endMarkerPos + 2));

  if (children.length <= 2) return null; // Only open and close markers means invalid

  return cx.elt("InternalLink", pos, endMarkerPos + 2, children);
}

export const internalLinkParser: MarkdownConfig = {
  defineNodes: [
    { name: "Embed", style: lezerHighlightEmbed },
    { name: "EmbedMark", style: lezerHighlightEmbedMark },
    { name: "InternalLink", style: lezerHighlightInternalLink },
    { name: "InternalMark", style: lezerHighlightInternalMark },
    { name: "InternalPath", style: lezerHighlightInternalPath },
    { name: "InternalSubpath", style: lezerHighlightInternalSubpath },
    { name: "InternalDisplay", style: lezerHighlightInternalDisplay },
  ],
  parseInline: [
    {
      name: "InternalLink",
      parse(cx: InlineContext, _: number, pos: number) {
        const el = parseInternalLink(cx, pos);
        if (el) {
          return cx.addElement(el);
        }
        return -1;
      },
      before: "Link",
    },
    {
      name: "Embed",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== 33 /* ! */) {
          return -1;
        }
        // Try to parse an internal link immediately after the "!"
        const linkElement = parseInternalLink(cx, pos + 1);
        if (linkElement) {
          const embedMark = cx.elt("EmbedMark", pos, pos + 1); // The "!"
          // Create "Embed" node wrapping "EmbedMark" and the "InternalLink" structure
          return cx.addElement(
            cx.elt("Embed", pos, linkElement.to, [embedMark, linkElement]),
          );
        }
        return -1;
      },
      before: "Image", // Parse before standard images ![]()
    },
  ],
};
