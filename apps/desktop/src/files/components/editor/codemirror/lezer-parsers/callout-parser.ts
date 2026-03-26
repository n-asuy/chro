/**
 * Callout parser for Obsidian-style callouts ([!note], [!warning], etc.)
 * Based on lezer-markdown-obsidian
 */

import type { MarkdownConfig, InlineContext } from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

const lezerHighlightCallout = Tag.define();
const lezerHighlightCalloutMark = Tag.define(lezerHighlightCallout);
const lezerHighlightCalloutType = Tag.define(lezerHighlightCallout);
const lezerHighlightCalloutFoldMark = Tag.define(lezerHighlightCallout);
const lezerHighlightCalloutTitle = Tag.define(lezerHighlightCallout);

// Regex: [!type][-/+]? optional-title
// Group 1: type, Group 2: fold mark, Group 3: title
const calloutRegex = /^\[!([^\]]+)\]([+-])?(.*)/;

export const calloutParser: MarkdownConfig = {
  defineNodes: [
    { name: "Callout", style: lezerHighlightCallout },
    { name: "CalloutMark", style: lezerHighlightCalloutMark },
    { name: "CalloutType", style: lezerHighlightCalloutType },
    { name: "CalloutFoldMark", style: lezerHighlightCalloutFoldMark },
    { name: "CalloutTitle", style: lezerHighlightCalloutTitle },
  ],
  parseInline: [
    {
      name: "Callout",
      parse(cx: InlineContext, _next: number, pos: number) {
        const text = cx.slice(pos, cx.end);
        const match = calloutRegex.exec(text);

        if (!match) {
          return -1;
        }

        const type = match[1];
        const fold = match[2];
        const title = match[3];

        if (!type) {
          return -1;
        }

        const fullMatchLength = match[0].length;
        const children = [];
        let currentPosInMatch = 0;

        // Mark for "[!"
        children.push(
          cx.elt(
            "CalloutMark",
            pos + currentPosInMatch,
            pos + currentPosInMatch + 2,
          ),
        );
        currentPosInMatch += 2;

        // Type
        children.push(
          cx.elt(
            "CalloutType",
            pos + currentPosInMatch,
            pos + currentPosInMatch + type.length,
          ),
        );
        currentPosInMatch += type.length;

        // Mark for "]"
        children.push(
          cx.elt(
            "CalloutMark",
            pos + currentPosInMatch,
            pos + currentPosInMatch + 1,
          ),
        );
        currentPosInMatch += 1;

        // Fold
        if (fold) {
          children.push(
            cx.elt(
              "CalloutFoldMark",
              pos + currentPosInMatch,
              pos + currentPosInMatch + 1,
            ),
          );
          currentPosInMatch += 1;
        }

        // Title
        if (title) {
          const trimmedTitle = title.trim();
          if (trimmedTitle.length > 0) {
            const titleStartOffset = title.indexOf(trimmedTitle);
            const titleStart = pos + currentPosInMatch + titleStartOffset;
            children.push(
              cx.elt(
                "CalloutTitle",
                titleStart,
                titleStart + trimmedTitle.length,
              ),
            );
          }
        }

        return cx.addElement(
          cx.elt("Callout", pos, pos + fullMatchLength, children),
        );
      },
      before: "Link",
    },
  ],
};
