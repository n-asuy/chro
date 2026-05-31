/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { parseFromDOM } from "../hooks/use-prompt-editor";
import { getSkillEntries } from "../types/context";

function makeEditor(html: string): HTMLDivElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

function makePill(path: string, isFile = true): string {
  const name = path.split("/").pop() ?? path;
  return `<span data-type="file" data-path="${path}" data-is-file="${isFile}" contenteditable="false">@${name}</span>`;
}

function makeSkillPill(id: string, name: string): string {
  return `<span data-type="skill" data-skill-id="${id}" data-skill-name="${name}" contenteditable="false">#${name}</span>`;
}

describe("parseFromDOM", () => {
  it("parses text-only content", () => {
    const el = makeEditor("hello world");
    const result = parseFromDOM(el);
    expect(result).toEqual([
      { type: "text", content: "hello world", start: 0, end: 11 },
    ]);
  });

  it("parses mixed text and pill", () => {
    const el = makeEditor(`fix ${makePill("src/a.ts")} bug`);
    const result = parseFromDOM(el);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: "text", content: "fix " });
    expect(result[1]).toMatchObject({
      type: "file",
      path: "src/a.ts",
      isFile: true,
    });
    expect(result[2]).toMatchObject({ type: "text", content: " bug" });
  });

  it("parses directory pill with isFile=false", () => {
    const el = makeEditor(makePill("src/lib", false));
    const result = parseFromDOM(el);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "file",
      path: "src/lib",
      isFile: false,
    });
  });

  it("parses skill pill content", () => {
    const el = makeEditor(
      `use ${makeSkillPill("workspace:.claude/skills:release", "release")} now`,
    );
    const result = parseFromDOM(el);
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({
      type: "skill",
      id: "workspace:.claude/skills:release",
      name: "release",
      content: "#release",
    });
    expect(getSkillEntries(result)).toEqual([
      { id: "workspace:.claude/skills:release", name: "release" },
    ]);
  });

  it("deduplicates repeated skill entries", () => {
    const el = makeEditor(
      `${makeSkillPill("user:.agents/skills:docs", "docs")} ${makeSkillPill(
        "user:.agents/skills:docs",
        "docs",
      )}`,
    );
    const result = parseFromDOM(el);
    expect(getSkillEntries(result)).toEqual([
      { id: "user:.agents/skills:docs", name: "docs" },
    ]);
  });

  it("defaults isFile to true when data-is-file is absent", () => {
    const el = makeEditor(
      '<span data-type="file" data-path="src/a.ts" contenteditable="false">@a.ts</span>',
    );
    const result = parseFromDOM(el);
    expect(result[0]).toMatchObject({
      type: "file",
      path: "src/a.ts",
      isFile: true,
    });
  });

  it("parses pill-only content", () => {
    const el = makeEditor(makePill("src/a.ts"));
    const result = parseFromDOM(el);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: "file",
      path: "src/a.ts",
    });
  });

  it("returns empty text part for empty editor", () => {
    const el = makeEditor("");
    const result = parseFromDOM(el);
    expect(result).toEqual([{ type: "text", content: "", start: 0, end: 0 }]);
  });

  it("handles block elements (DIV) as line breaks", () => {
    const el = makeEditor("<div>line1</div><div>line2</div>");
    const result = parseFromDOM(el);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "text" });
    expect((result[0] as { content: string }).content).toContain("line1");
    expect((result[0] as { content: string }).content).toContain("line2");
    expect((result[0] as { content: string }).content).toContain("\n");
  });

  it("strips zero-width space", () => {
    const el = makeEditor("\u200Bhello");
    const result = parseFromDOM(el);
    expect(result).toEqual([
      expect.objectContaining({ type: "text", content: "hello" }),
    ]);
  });

  it("parses text after pill deletion (pill removed from DOM)", () => {
    const el = makeEditor("fix  bug");
    const result = parseFromDOM(el);
    expect(result).toEqual([
      { type: "text", content: "fix  bug", start: 0, end: 8 },
    ]);
  });

  it("handles BR elements as newlines", () => {
    const el = makeEditor("hello<br>world");
    const result = parseFromDOM(el);
    expect(result).toHaveLength(1);
    expect((result[0] as { content: string }).content).toBe("hello\nworld");
  });
});
