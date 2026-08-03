import { markdown } from "@codemirror/lang-markdown";
import {
  EditorSelection,
  EditorState,
  type StateField,
} from "@codemirror/state";
import type { Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { customOFMParsers } from "../../../lezer-parsers";
import { htmlPlugin } from "../html-plugin";

/**
 * Build an EditorState wired with the same markdown parser the WYSIWYG editor
 * uses, plus the HTML state field under test.
 */
function createState(doc: string, cursor: number): EditorState {
  const markdownLanguage = markdown({
    // @ts-expect-error - parser version mismatch, identical to wysiwyg.ts
    extensions: [GFM, ...customOFMParsers, { remove: ["SetextHeading"] }],
  });

  return EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdownLanguage, htmlPlugin],
  });
}

interface DecorationRange {
  from: number;
  to: number;
  /** `undefined` for mark decorations, which render the raw source instead. */
  widget: WidgetType | undefined;
  block: boolean;
  class: string | undefined;
}

const htmlDecorationField = htmlPlugin[0] as StateField<DecorationSet>;

function decorations(state: EditorState): DecorationRange[] {
  const found: DecorationRange[] = [];
  state
    .field(htmlDecorationField)
    .between(0, state.doc.length, (from, to, value) => {
      const spec = (value as Decoration).spec;
      found.push({
        from,
        to,
        widget: spec?.widget,
        block: spec?.block === true,
        class: spec?.class,
      });
    });
  return found;
}

/** A diagram of the shape that motivated SVG support. */
const SVG_BLOCK = `<div class="dgm">
<p class="dt">Turn timeline</p>
<svg viewBox="0 0 1000 300" role="img" aria-label="Turn timeline">
  <line x1="70" y1="120" x2="960" y2="120" stroke="var(--grayb)" stroke-width="1.5"/>
  <rect x="70" y="96" width="150" height="48" rx="5" fill="var(--b50)"/>
  <text class="t-md" x="145" y="125" text-anchor="middle">speaking</text>
</svg>
</div>`;

describe("htmlPlugin", () => {
  it("replaces an HTML block with a block widget when the cursor is elsewhere", () => {
    const doc = `${SVG_BLOCK}\n\ntrailing paragraph`;
    const state = createState(doc, doc.length);

    const [decoration, ...rest] = decorations(state);
    expect(rest).toEqual([]);
    expect(decoration.from).toBe(0);
    expect(decoration.block).toBe(true);
    expect(decoration.widget).toBeDefined();
  });

  it("shows the raw source while the cursor sits inside the block", () => {
    const state = createState(SVG_BLOCK, 10);

    const [decoration, ...rest] = decorations(state);
    expect(rest).toEqual([]);
    expect(decoration.widget).toBeUndefined();
    expect(decoration.class).toBe("cm-html-block-editing");
  });

  it("renders inline HTML with an inline widget", () => {
    const doc = "text with <mark>highlight</mark> inside";
    const state = createState(doc, 0);

    const inline = decorations(state);
    expect(inline.length).toBeGreaterThan(0);
    for (const decoration of inline) {
      expect(decoration.block).toBe(false);
      expect(decoration.widget).toBeDefined();
    }
  });

  describe("estimated height", () => {
    function estimatedHeightOf(doc: string): number | undefined {
      const state = createState(doc, doc.length);
      return decorations(state)[0]?.widget?.estimatedHeight;
    }

    it("derives the height of a viewBox-only diagram from its aspect ratio", () => {
      // 1000x300 viewBox in a 700px content column is ~210px tall, not the 50px
      // an unmeasured block would otherwise claim.
      expect(estimatedHeightOf(`${SVG_BLOCK}\n\ntrailing`)).toBe(210);
    });

    it("prefers an explicit pixel height over the viewBox", () => {
      const doc =
        '<div>\n<svg viewBox="0 0 1000 300" height="240"></svg>\n</div>\n\ntrailing';
      expect(estimatedHeightOf(doc)).toBe(240);
    });

    it("ignores heights that do not resolve to pixels", () => {
      const doc =
        '<div>\n<svg viewBox="0 0 100 100" height="100%"></svg>\n</div>\n\ntrailing';
      expect(estimatedHeightOf(doc)).toBe(700);
    });

    it("falls back to a default for HTML without declared geometry", () => {
      const doc = "<details>\n<summary>More</summary>\n</details>\n\ntrailing";
      expect(estimatedHeightOf(doc)).toBe(50);
    });
  });

  it("leaves both halves of a block-level tag pair as source when inlined", () => {
    // A lone `<svg>` line is not a CommonMark HTML block, so the parser emits
    // inline tags. Neither half may be swallowed by an empty inline widget.
    const doc = '<svg viewBox="0 0 10 10"></svg> trailing';
    const state = createState(doc, doc.length);

    expect(decorations(state)).toEqual([]);
  });

  it("ends an HTML block at a blank line, matching CommonMark", () => {
    // Worth pinning down: a blank line inside a hand-written <svg> silently
    // splits it, and everything after the blank line renders as plain text.
    const doc = "<div>\n<p>kept</p>\n\n<p>dropped</p>\n</div>";
    const state = createState(doc, doc.length);

    const [decoration] = decorations(state);
    expect(decoration.from).toBe(0);
    expect(state.doc.sliceString(decoration.from, decoration.to)).toBe(
      "<div>\n<p>kept</p>",
    );
  });
});
