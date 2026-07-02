import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { customOFMParsers } from "../../../lezer-parsers";
import { highlightPlugin } from "../highlight-plugin";

/**
 * Build an EditorState wired with the same markdown parser the WYSIWYG editor
 * uses, plus the highlight state field under test. The selection is placed so
 * the highlight node is NOT active (otherwise the plugin intentionally skips
 * decorating it), which is the configuration that exposes the crash.
 */
function createState(doc: string, cursor: number): EditorState {
  const markdownLanguage = markdown({
    // The lezer-markdown-obsidian parsers target a slightly different
    // @lezer/markdown version, matching the editor's own configuration.
    // @ts-expect-error - parser version mismatch, identical to wysiwyg.ts
    extensions: [GFM, ...customOFMParsers, { remove: ["SetextHeading"] }],
  });

  return EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdownLanguage, highlightPlugin],
  });
}

function highlightedRanges(state: EditorState): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  state
    .field(highlightPlugin)
    .between(0, state.doc.length, (from, to, value) => {
      if ((value as Decoration).spec?.class === "cm-highlighted") {
        ranges.push([from, to]);
      }
    });
  return ranges;
}

describe("highlightPlugin", () => {
  it("does not crash on an empty highlight (==== with the cursor elsewhere)", () => {
    // Regression: an empty highlight yields a zero-width mark decoration, and
    // CodeMirror throws "Mark decorations may not be empty", taking down the
    // entire editor via the route error boundary.
    expect(() => createState("====\n\ntext", 6)).not.toThrow();

    const state = createState("====\n\ntext", 6);
    expect(highlightedRanges(state)).toEqual([]);
  });

  it("still decorates a non-empty highlight when the cursor is away", () => {
    const state = createState("==word==\n\ntext", 12);
    // "==word==" -> content "word" spans positions 2..6.
    expect(highlightedRanges(state)).toEqual([[2, 6]]);
  });
});
