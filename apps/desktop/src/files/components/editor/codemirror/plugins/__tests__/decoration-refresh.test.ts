import { markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState, type StateField } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { customOFMParsers } from "../../lezer-parsers";
import { codeblockPlugin } from "../prose/codeblock-plugin";
import { htmlPlugin } from "../prose/html-plugin";

/**
 * CodeMirror parses only the first ~3000 characters when a state is created and
 * extends the tree in the background as the user scrolls. Decoration fields
 * therefore have to rebuild when the parse advances, or everything below the
 * initial window stays raw markdown forever.
 */

const PARAGRAPH =
  "Prose that pads the document past the initial parse window so the block below starts unparsed.\n\n";
const FILLER = PARAGRAPH.repeat(40);

function createState(doc: string, field: unknown): EditorState {
  const markdownLanguage = markdown({
    // @ts-expect-error - parser version mismatch, identical to wysiwyg.ts
    extensions: [GFM, ...customOFMParsers, { remove: ["SetextHeading"] }],
  });

  return EditorState.create({
    doc,
    extensions: [markdownLanguage, field as never],
  });
}

/** Advance the parse the way the background parse worker does while scrolling. */
function parseWholeDocument(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state.update({}).state;
}

function decorationClasses(
  state: EditorState,
  field: StateField<DecorationSet>,
): string[] {
  const classes: string[] = [];
  state.field(field).between(0, state.doc.length, (_from, _to, value) => {
    const spec = (value as Decoration).spec;
    const lineClass = spec?.attributes?.class ?? spec?.class;
    if (lineClass) classes.push(lineClass as string);
  });
  return classes;
}

function decorationCount(
  state: EditorState,
  field: StateField<DecorationSet>,
): number {
  let count = 0;
  state.field(field).between(0, state.doc.length, () => {
    count++;
  });
  return count;
}

describe("decorations below the initial parse window", () => {
  it("styles a fenced code block once the parse reaches it", () => {
    const doc = `${FILLER}\`\`\`text\nfenced body\n\`\`\`\n`;
    const state = createState(doc, codeblockPlugin);

    // Premise: the block is outside the tree the state was created with.
    expect(syntaxTree(state).length).toBeLessThan(doc.length);
    expect(decorationClasses(state, codeblockPlugin)).toEqual([]);

    const parsed = parseWholeDocument(state);

    expect(syntaxTree(parsed).length).toBe(doc.length);
    expect(decorationClasses(parsed, codeblockPlugin)).toEqual([
      "cm-codeblock cm-line-codeblock-begin",
      "cm-codeblock cm-line-codeblock-middle",
      "cm-codeblock cm-line-codeblock-end",
    ]);
  });

  it("renders a memoized block scan once the parse reaches it", () => {
    const doc = `${FILLER}<div class="card">late html</div>\n`;
    const field = htmlPlugin[0] as StateField<DecorationSet>;
    const state = createState(doc, htmlPlugin);

    expect(syntaxTree(state).length).toBeLessThan(doc.length);
    expect(decorationCount(state, field)).toBe(0);

    const parsed = parseWholeDocument(state);

    expect(decorationCount(parsed, field)).toBeGreaterThan(0);
  });
});
