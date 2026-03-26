/**
 * Indentation parser for list indentation
 * Based on lezer-markdown-obsidian
 */

import type { MarkdownConfig, InlineContext } from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

export const lezerHighlightIndentation = Tag.define();

// This regex matches one tab or 4 spaces.
const indentationRegex = /^((?:\t| {4})+)/;

export const indentationParser: MarkdownConfig = {
  defineNodes: [{ name: "Indentation", style: lezerHighlightIndentation }],
  parseInline: [
    {
      name: "Indentation",
      parse(cx: InlineContext, _next: number, pos: number) {
        // We only want to match at the beginning of a line.
        if (pos > 0 && cx.slice(pos - 1, pos) !== "\n") {
          return -1;
        }

        const match = indentationRegex.exec(cx.slice(pos, cx.end));
        if (!match) {
          return -1;
        }

        const matchLength = match[0].length;
        return cx.addElement(cx.elt("Indentation", pos, pos + matchLength));
      },
      before: "Emphasis",
    },
  ],
};
