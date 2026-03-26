/**
 * LaTeX/TeX parser for inline ($...$) and block ($$...$$) math
 * Based on lezer-markdown-obsidian
 */

import type {
  MarkdownConfig,
  BlockContext,
  InlineContext,
  Line,
} from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

const TexDelim = { resolve: "TexInline", mark: "TexMarker" };

const lezerHighlightLatex = Tag.define("Tex");
export const lezerHighlightLatexBlock = Tag.define("TexBlock");
export const lezerHighlightLatexInline = Tag.define("TexInline");
export const lezerHighlightLatexMarker = Tag.define("TexMarker");

export const latexParser: MarkdownConfig = {
  defineNodes: [
    { name: "Tex", style: lezerHighlightLatex },
    { name: "TexBlock", style: lezerHighlightLatexBlock },
    { name: "TexInline", style: lezerHighlightLatexInline },
    { name: "TexMarker", style: lezerHighlightLatexMarker },
  ],
  parseBlock: [
    {
      name: "TexBlock",
      endLeaf: (_, line: Line) =>
        line.text.slice(line.pos, line.pos + 2) === "$$",
      parse(cx: BlockContext, line: Line) {
        if (line.text.slice(line.pos, line.pos + 2) !== "$$") {
          return false;
        }
        const start = cx.lineStart + line.pos;
        const markers = [cx.elt("TexMarker", start, start + 2)]; // Opening "$$"
        const regex = /(^|[^\\])\$\$/; // Match non-escaped "$$"
        let remaining = line.text.slice(line.pos + 2);
        let startOffset = 2;
        let match;

        // Search for closing "$$"
        while (!(match = regex.exec(remaining)) && cx.nextLine()) {
          remaining = line.text;
          startOffset = 0;
        }

        let end;
        if (match) {
          const lineEnd = match.index + match[0].length + startOffset;
          end = cx.lineStart + lineEnd;
          markers.push(cx.elt("TexMarker", end - 2, end)); // Closing "$$"

          // Consume the line if "$$" is at the end or followed by whitespace
          if (
            lineEnd === line.text.length ||
            /^\s*$/.test(line.text.slice(lineEnd))
          ) {
            cx.nextLine();
          } else {
            line.pos = line.skipSpace(lineEnd);
          }
        } else {
          end = cx.lineStart + line.text.length;
        }
        cx.addElement(cx.elt("TexBlock", start, end, markers));
        return true;
      },
      before: "FencedCode",
    },
  ],
  parseInline: [
    {
      name: "TexInline",
      parse(cx: InlineContext, next: number, pos: number) {
        if (next !== 36 /* $ */) {
          return -1;
        }
        // Check if the next char is also '$', if so, defer to block parser
        if (cx.char(pos + 1) === 36) return -1;

        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 1, pos + 2);

        let canOpen = !/\s/.test(after) && after !== "$";
        let canClose = !/\s/.test(before) && before !== "$";

        if (cx.char(pos - 1) === 32 && cx.char(pos + 1) === 32) {
          canOpen = false;
          canClose = false;
        }

        return cx.addDelimiter(TexDelim, pos, pos + 1, canOpen, canClose);
      },
      before: "Emphasis",
    },
  ],
};
