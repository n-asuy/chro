import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { customOFMParsers } from "../../../lezer-parsers";
import { markdownLinkPlugin } from "../markdown-link-plugin";

type DecorationInfo = {
  from: number;
  to: number;
  className?: string;
  attributes?: Record<string, string>;
  replaced: boolean;
};

function decorations(doc: string, cursor: number): DecorationInfo[] {
  const markdownLanguage = markdown({
    // @ts-expect-error - parser version mismatch, identical to wysiwyg.ts
    extensions: [GFM, ...customOFMParsers, { remove: ["SetextHeading"] }],
  });
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(cursor),
    extensions: [markdownLanguage, markdownLinkPlugin],
  });

  const result: DecorationInfo[] = [];
  state
    .field(markdownLinkPlugin)
    .between(0, state.doc.length, (from, to, value) => {
      const spec = (value as Decoration).spec as {
        class?: string;
        attributes?: Record<string, string>;
      };
      result.push({
        from,
        to,
        className: spec.class,
        attributes: spec.attributes,
        replaced: (value as Decoration).point && from !== to,
      });
    });
  return result;
}

const hasClass = (d: DecorationInfo, name: string): boolean =>
  d.className?.split(" ").includes(name) ?? false;

/** The text a reader sees once every replaced range is removed. */
function visibleText(doc: string, cursor: number): string {
  const hidden = decorations(doc, cursor).filter((d) => d.replaced);
  let text = "";
  for (let i = 0; i < doc.length; i++) {
    if (!hidden.some((d) => i >= d.from && i < d.to)) text += doc[i];
  }
  return text;
}

describe("markdownLinkPlugin", () => {
  it("shows only the label of a link to a local file", () => {
    const doc = "前例（[研究実測まとめ](20260721_音声AI研究実測まとめ.html)）\n\nend";
    const cursor = doc.length;

    expect(visibleText(doc, cursor)).toBe("前例（研究実測まとめ）\n\nend");
  });

  it("marks a local link as an internal link carrying its path", () => {
    const doc = "[report](notes/report%20v2.md)\n\nend";
    const link = decorations(doc, doc.length).find((d) =>
      hasClass(d, "cm-internal-link"),
    );

    expect(link).toMatchObject({
      from: 0,
      to: "[report](notes/report%20v2.md)".length,
      attributes: { "data-link-path": "notes/report v2.md" },
    });
  });

  it("reveals the raw syntax of a local link while the cursor is inside it", () => {
    const doc = "[report](report.md)\n\nend";

    expect(visibleText(doc, 3)).toBe(doc);
    expect(
      decorations(doc, 3).find((d) => hasClass(d, "cm-internal-link"))
        ?.className,
    ).toContain("cm-internal-link-editing");
  });

  it("keeps an external link external", () => {
    const doc = "[site](https://example.com)\n\nend";

    expect(visibleText(doc, doc.length)).toBe("site\n\nend");
    expect(
      decorations(doc, doc.length).find((d) =>
        hasClass(d, "cm-external-link"),
      )?.attributes,
    ).toMatchObject({ "data-link-url": "https://example.com" });
  });

  it("shows only the text of a link that opens nothing, without making it clickable", () => {
    for (const [doc, text] of [
      ["see [top](#heading)\n\nend", "see top\n\nend"],
      ["see [mail](mailto:a@b.c)\n\nend", "see mail\n\nend"],
    ]) {
      expect(visibleText(doc, doc.length)).toBe(text);
      expect(
        decorations(doc, doc.length).filter((d) => d.attributes),
      ).toEqual([]);
    }
  });
});
