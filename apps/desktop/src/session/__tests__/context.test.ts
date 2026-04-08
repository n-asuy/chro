import { describe, it, expect } from "vitest";
import {
  extractSessionId,
  formatContextForPrompt,
  getContextEntries,
  inferTaskDescriptionFromContent,
  inferTaskTitleFromContent,
  parseContextFromContent,
  type ContextEntry,
  type Prompt,
  type TextPart,
  type FileAttachmentPart,
} from "../types/context";

const text = (content: string, start = 0): TextPart => ({
  type: "text",
  content,
  start,
  end: start + content.length,
});

const file = (path: string, isFile = true, start = 0): FileAttachmentPart => ({
  type: "file",
  content: `@${path.split("/").pop()}`,
  path,
  isFile,
  start,
  end: start + path.split("/").pop()!.length + 1,
});

const entry = (path: string, isFile = true, branch?: string): ContextEntry => {
  const e: ContextEntry = { path, isFile };
  if (branch) e.branch = branch;
  return e;
};

describe("extractSessionId", () => {
  it("extracts short ID from a valid session transcript path", () => {
    expect(
      extractSessionId(
        ".chro-context/sessions/bd7a332a-897c-4f4c-9f4b-b477c9bcf808.md",
      ),
    ).toBe("bd7a332a");
  });

  it("returns null for a regular file path", () => {
    expect(extractSessionId("src/main.ts")).toBeNull();
  });

  it("returns null for a path with .chro-context but not sessions", () => {
    expect(extractSessionId(".chro-context/images/abc.png")).toBeNull();
  });

  it("returns null for a malformed UUID", () => {
    expect(
      extractSessionId(".chro-context/sessions/not-a-uuid.md"),
    ).toBeNull();
  });

  it("returns null for missing .md extension", () => {
    expect(
      extractSessionId(
        ".chro-context/sessions/bd7a332a-897c-4f4c-9f4b-b477c9bcf808",
      ),
    ).toBeNull();
  });
});

describe("formatContextForPrompt", () => {
  it("returns empty string for empty array", () => {
    expect(formatContextForPrompt([])).toBe("");
  });

  it("wraps a single file in context tags", () => {
    expect(formatContextForPrompt([entry("src/main.ts")])).toBe(
      '<context>\n<file path="src/main.ts" />\n</context>',
    );
  });

  it("wraps multiple files in context tags", () => {
    const result = formatContextForPrompt([entry("a.ts"), entry("b.ts")]);
    expect(result).toBe(
      '<context>\n<file path="a.ts" />\n<file path="b.ts" />\n</context>',
    );
  });

  it("uses <directory> tag for non-file entries", () => {
    const result = formatContextForPrompt([entry("src/lib", false)]);
    expect(result).toBe(
      '<context>\n<directory path="src/lib" />\n</context>',
    );
  });

  it("mixes file and directory tags", () => {
    const result = formatContextForPrompt([
      entry("src/main.ts", true),
      entry("src/lib", false),
    ]);
    expect(result).toBe(
      '<context>\n<file path="src/main.ts" />\n<directory path="src/lib" />\n</context>',
    );
  });

  it("escapes double quotes in paths", () => {
    const result = formatContextForPrompt([entry('path/"with"quotes.ts')]);
    expect(result).toContain('path/&quot;with&quot;quotes.ts');
  });

  it("escapes &, <, > in paths", () => {
    const result = formatContextForPrompt([entry("a&b<c>d.ts")]);
    expect(result).toContain("a&amp;b&lt;c&gt;d.ts");
  });

  it("includes branch attribute when present", () => {
    const result = formatContextForPrompt([
      entry(".chro-context/sessions/abc.md", true, "feature/auth"),
    ]);
    expect(result).toBe(
      '<context>\n<file path=".chro-context/sessions/abc.md" branch="feature/auth" />\n</context>',
    );
  });

  it("omits branch attribute when not set", () => {
    const result = formatContextForPrompt([entry("src/main.ts")]);
    expect(result).not.toContain("branch");
  });

  it("escapes special characters in branch name", () => {
    const result = formatContextForPrompt([
      entry("a.md", true, 'feat/"quotes"'),
    ]);
    expect(result).toContain('branch="feat/&quot;quotes&quot;"');
  });
});

describe("getContextEntries", () => {
  it("returns empty array when no file parts", () => {
    const prompt: Prompt = [text("hello")];
    expect(getContextEntries(prompt)).toEqual([]);
  });

  it("returns entry from a single file part", () => {
    const prompt: Prompt = [file("a.ts")];
    expect(getContextEntries(prompt)).toEqual([{ path: "a.ts", isFile: true }]);
  });

  it("returns entry for directory part", () => {
    const prompt: Prompt = [file("src/lib", false)];
    expect(getContextEntries(prompt)).toEqual([{ path: "src/lib", isFile: false }]);
  });

  it("deduplicates paths", () => {
    const prompt: Prompt = [
      file("a.ts"),
      text(" "),
      file("a.ts"),
    ];
    expect(getContextEntries(prompt)).toEqual([{ path: "a.ts", isFile: true }]);
  });

  it("preserves insertion order after dedup", () => {
    const prompt: Prompt = [
      file("b.ts"),
      file("a.ts"),
      file("b.ts"),
    ];
    expect(getContextEntries(prompt)).toEqual([
      { path: "b.ts", isFile: true },
      { path: "a.ts", isFile: true },
    ]);
  });

  it("preserves branch from FileAttachmentPart", () => {
    const part: FileAttachmentPart = {
      ...file("session.md"),
      branch: "feature/xyz",
    };
    const prompt: Prompt = [part];
    expect(getContextEntries(prompt)).toEqual([
      { path: "session.md", isFile: true, branch: "feature/xyz" },
    ]);
  });
});

describe("parseContextFromContent", () => {
  it("returns full content as text when no context block", () => {
    const result = parseContextFromContent("hello world");
    expect(result).toEqual({
      contextEntries: [],
      imageEntries: [],
      text: "hello world",
    });
  });

  it("parses a single file entry", () => {
    const content = '<context>\n<file path="src/main.ts" />\n</context>\nfix the bug';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([{ path: "src/main.ts", isFile: true }]);
    expect(result.text).toBe("fix the bug");
  });

  it("parses multiple file entries", () => {
    const content = '<context>\n<file path="a.ts" />\n<file path="b.ts" />\n</context>\ndo something';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([
      { path: "a.ts", isFile: true },
      { path: "b.ts", isFile: true },
    ]);
    expect(result.text).toBe("do something");
  });

  it("parses directory entries with isFile=false", () => {
    const content = '<context>\n<directory path="src/lib" />\n</context>\ncheck this';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([{ path: "src/lib", isFile: false }]);
    expect(result.text).toBe("check this");
  });

  it("parses mixed file and directory entries", () => {
    const content = '<context>\n<file path="src/main.ts" />\n<directory path="src/lib" />\n</context>\nmixed';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([
      { path: "src/main.ts", isFile: true },
      { path: "src/lib", isFile: false },
    ]);
    expect(result.text).toBe("mixed");
  });

  it("unescapes XML-encoded characters in paths", () => {
    const content = '<context>\n<file path="a&amp;b&lt;c&gt;d&quot;e.ts" />\n</context>\ntest';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([{ path: 'a&b<c>d"e.ts', isFile: true }]);
    expect(result.text).toBe("test");
  });

  it("returns empty text when no content after context block", () => {
    const content = '<context>\n<file path="a.ts" />\n</context>';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([{ path: "a.ts", isFile: true }]);
    expect(result.text).toBe("");
  });

  it("does not parse context block that appears mid-content", () => {
    const content = 'some text\n<context>\n<file path="a.ts" />\n</context>';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([]);
    expect(result.text).toBe(content);
  });

  it("roundtrips with formatContextForPrompt", () => {
    const entries: ContextEntry[] = [
      { path: "src/main.ts", isFile: true },
      { path: "docs", isFile: false },
    ];
    const userText = "fix everything";
    const serialized = formatContextForPrompt(entries) + "\n" + userText;
    const result = parseContextFromContent(serialized);
    expect(result.contextEntries).toEqual(entries);
    expect(result.text).toBe(userText);
  });

  it("roundtrips paths with special characters", () => {
    const entries: ContextEntry[] = [{ path: 'path/"with"quotes & <angles>.ts', isFile: true }];
    const userText = "handle this";
    const serialized = formatContextForPrompt(entries) + "\n" + userText;
    const result = parseContextFromContent(serialized);
    expect(result.contextEntries).toEqual(entries);
    expect(result.text).toBe(userText);
  });

  it("extracts image markdown into imageEntries", () => {
    const content = "![screenshot.png](.chro-context/abc.png)\nhello";
    const result = parseContextFromContent(content);
    expect(result.imageEntries).toEqual([
      { name: "screenshot.png", path: ".chro-context/abc.png" },
    ]);
    expect(result.text).toBe("hello");
    expect(result.contextEntries).toEqual([]);
  });

  it("extracts multiple images", () => {
    const content =
      "![a.png](path/a.png)\n![b.jpg](path/b.jpg)\ncheck these";
    const result = parseContextFromContent(content);
    expect(result.imageEntries).toEqual([
      { name: "a.png", path: "path/a.png" },
      { name: "b.jpg", path: "path/b.jpg" },
    ]);
    expect(result.text).toBe("check these");
  });

  it("extracts images alongside context entries", () => {
    const content =
      '<context>\n<file path="src/main.ts" />\n</context>\n![img.png](.chro-context/img.png)\nfix this';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([
      { path: "src/main.ts", isFile: true },
    ]);
    expect(result.imageEntries).toEqual([
      { name: "img.png", path: ".chro-context/img.png" },
    ]);
    expect(result.text).toBe("fix this");
  });

  it("returns empty imageEntries when no images", () => {
    const result = parseContextFromContent("no images here");
    expect(result.imageEntries).toEqual([]);
  });

  it("parses branch attribute from file tag", () => {
    const content =
      '<context>\n<file path="session.md" branch="feature/auth" />\n</context>\nfix it';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([
      { path: "session.md", isFile: true, branch: "feature/auth" },
    ]);
    expect(result.text).toBe("fix it");
  });

  it("parses entries with and without branch", () => {
    const content =
      '<context>\n<file path="session.md" branch="main" />\n<file path="src/app.ts" />\n</context>\ndo it';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([
      { path: "session.md", isFile: true, branch: "main" },
      { path: "src/app.ts", isFile: true },
    ]);
  });

  it("roundtrips entries with branch", () => {
    const entries: ContextEntry[] = [
      { path: "session.md", isFile: true, branch: "feature/new-ui" },
      { path: "src/main.ts", isFile: true },
    ];
    const userText = "check branch context";
    const serialized = formatContextForPrompt(entries) + "\n" + userText;
    const result = parseContextFromContent(serialized);
    expect(result.contextEntries).toEqual(entries);
    expect(result.text).toBe(userText);
  });
});

describe("inferTaskTitleFromContent", () => {
  it("uses the first non-empty line after a leading context block", () => {
    const content =
      '<context>\n<file path="src/main.ts" />\n</context>\n\nfix the bug\nmore detail';
    expect(inferTaskTitleFromContent(content)).toBe("fix the bug");
  });

  it("falls back when content only has context", () => {
    const content = '<context>\n<file path="src/main.ts" />\n</context>';
    expect(inferTaskTitleFromContent(content, () => "Session fallback")).toBe(
      "Session fallback",
    );
  });
});

describe("inferTaskDescriptionFromContent", () => {
  it("returns trailing text when no context exists", () => {
    expect(inferTaskDescriptionFromContent("fix the bug\nadd tests")).toBe(
      "add tests",
    );
  });

  it("excludes leading context from the description", () => {
    const content =
      '<context>\n<file path="src/main.ts" />\n</context>\nfix the bug\nadd tests';
    expect(inferTaskDescriptionFromContent(content)).toBe("add tests");
  });

  it("returns null for context-only prompts", () => {
    const content = '<context>\n<file path="src/main.ts" />\n</context>';
    expect(inferTaskDescriptionFromContent(content)).toBeNull();
  });
});
