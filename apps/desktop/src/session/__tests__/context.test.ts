import { describe, expect, it } from "vitest";
import {
  type ContextEntry,
  type FileAttachmentPart,
  type FileContextEntry,
  type Prompt,
  type SessionAttachmentPart,
  type SessionContextEntry,
  type SkillEntry,
  type TextPart,
  contextEntriesToRefs,
  formatContextForPrompt,
  formatSkillContextForPrompt,
  getContextEntries,
  inferTaskDescriptionFromContent,
  inferTaskTitleFromContent,
  parseContextFromContent,
  shortSessionId,
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

const sessionPart = (
  taskId: string,
  branch?: string,
  start = 0,
): SessionAttachmentPart => {
  const part: SessionAttachmentPart = {
    type: "session",
    content: `@${shortSessionId(taskId)}`,
    taskId,
    start,
    end: start + shortSessionId(taskId).length + 1,
  };
  if (branch) part.branch = branch;
  return part;
};

const fileEntry = (
  path: string,
  isFile = true,
  branch?: string,
): FileContextEntry => {
  const e: FileContextEntry = { kind: "file", path, isFile };
  if (branch) e.branch = branch;
  return e;
};

const sessionEntry = (taskId: string, branch?: string): SessionContextEntry => {
  const e: SessionContextEntry = { kind: "session", taskId };
  if (branch) e.branch = branch;
  return e;
};

const TASK_ID = "bd7a332a-897c-4f4c-9f4b-b477c9bcf808";

const skillEntry = (id: string, name: string): SkillEntry => ({ id, name });

describe("shortSessionId", () => {
  it("returns the first eight characters of a UUID", () => {
    expect(shortSessionId(TASK_ID)).toBe("bd7a332a");
  });
});

describe("formatContextForPrompt", () => {
  it("returns empty string for empty array", () => {
    expect(formatContextForPrompt([])).toBe("");
  });

  it("wraps a single file in context tags", () => {
    expect(formatContextForPrompt([fileEntry("src/main.ts")])).toBe(
      '<context>\n<file path="src/main.ts" />\n</context>',
    );
  });

  it("uses <directory> tag for non-file entries", () => {
    expect(formatContextForPrompt([fileEntry("src/lib", false)])).toBe(
      '<context>\n<directory path="src/lib" />\n</context>',
    );
  });

  it("escapes XML special characters in paths", () => {
    const result = formatContextForPrompt([fileEntry("a&b<c>d.ts")]);
    expect(result).toContain("a&amp;b&lt;c&gt;d.ts");
  });

  it("includes branch attribute on file entries when present", () => {
    expect(
      formatContextForPrompt([fileEntry("src/main.ts", true, "feature/auth")]),
    ).toBe(
      '<context>\n<file path="src/main.ts" branch="feature/auth" />\n</context>',
    );
  });

  it("renders a session entry with the escalation hint inside <past_session>", () => {
    const result = formatContextForPrompt([sessionEntry(TASK_ID)]);
    expect(result).toBe(
      [
        "<context>",
        `<past_session task_id="${TASK_ID}">`,
        `Referenced session. A summary is injected at execution time; run \`chro task logs ${TASK_ID}\` for the full transcript.`,
        "</past_session>",
        "</context>",
      ].join("\n"),
    );
  });

  it("includes branch on a session entry", () => {
    const result = formatContextForPrompt([sessionEntry(TASK_ID, "feature/x")]);
    expect(result).toContain(
      `<past_session task_id="${TASK_ID}" branch="feature/x">`,
    );
  });

  it("renders mixed file and session entries", () => {
    const result = formatContextForPrompt([
      fileEntry("src/main.ts"),
      sessionEntry(TASK_ID),
    ]);
    expect(result).toContain('<file path="src/main.ts" />');
    expect(result).toContain(`<past_session task_id="${TASK_ID}">`);
  });
});

describe("formatSkillContextForPrompt", () => {
  it("returns empty string for empty array", () => {
    expect(formatSkillContextForPrompt([])).toBe("");
  });

  it("wraps skill entries in display-only skill context tags", () => {
    expect(
      formatSkillContextForPrompt([
        skillEntry("workspace:.agents/skills:release", "release"),
      ]),
    ).toBe(
      '<skills_context>\n<skill id="workspace:.agents/skills:release" name="release" />\n</skills_context>',
    );
  });

  it("escapes XML special characters in skill attributes", () => {
    const result = formatSkillContextForPrompt([
      skillEntry('user:skills:a&b"c', 'docs & "notes"'),
    ]);
    expect(result).toContain('id="user:skills:a&amp;b&quot;c"');
    expect(result).toContain('name="docs &amp; &quot;notes&quot;"');
  });
});

describe("getContextEntries", () => {
  it("returns empty array when no attachment parts", () => {
    expect(getContextEntries([text("hello")])).toEqual([]);
  });

  it("collects file parts as file entries", () => {
    expect(getContextEntries([file("a.ts")])).toEqual([fileEntry("a.ts")]);
  });

  it("collects directory parts as file entries with isFile=false", () => {
    expect(getContextEntries([file("src/lib", false)])).toEqual([
      fileEntry("src/lib", false),
    ]);
  });

  it("collects session parts as session entries", () => {
    expect(getContextEntries([sessionPart(TASK_ID)])).toEqual([
      sessionEntry(TASK_ID),
    ]);
  });

  it("preserves branch on session entries", () => {
    expect(getContextEntries([sessionPart(TASK_ID, "feature/x")])).toEqual([
      sessionEntry(TASK_ID, "feature/x"),
    ]);
  });

  it("dedupes by path / taskId while preserving order", () => {
    const prompt: Prompt = [
      file("b.ts"),
      sessionPart(TASK_ID),
      file("a.ts"),
      sessionPart(TASK_ID),
      file("b.ts"),
    ];
    expect(getContextEntries(prompt)).toEqual([
      fileEntry("b.ts"),
      sessionEntry(TASK_ID),
      fileEntry("a.ts"),
    ]);
  });

  it("preserves branch from FileAttachmentPart", () => {
    const part: FileAttachmentPart = {
      ...file("session.md"),
      branch: "feature/xyz",
    };
    expect(getContextEntries([part])).toEqual([
      fileEntry("session.md", true, "feature/xyz"),
    ]);
  });
});

describe("contextEntriesToRefs", () => {
  it("converts session and file context entries to API refs", () => {
    expect(
      contextEntriesToRefs([
        sessionEntry(TASK_ID, "feature/x"),
        fileEntry("src/main.ts"),
        fileEntry("src/lib", false, "main"),
      ]),
    ).toEqual([
      {
        kind: "session",
        task_id: TASK_ID,
        branch: "feature/x",
        mode: "transcript",
      },
      { kind: "file", path: "src/main.ts", mode: "link" },
      { kind: "directory", path: "src/lib", branch: "main", mode: "link" },
    ]);
  });
});

describe("parseContextFromContent", () => {
  it("returns full content as text when no context block", () => {
    const result = parseContextFromContent("hello world");
    expect(result).toEqual({
      contextEntries: [],
      skillEntries: [],
      imageEntries: [],
      text: "hello world",
    });
  });

  it("parses a single file entry", () => {
    const content =
      '<context>\n<file path="src/main.ts" />\n</context>\nfix the bug';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([fileEntry("src/main.ts")]);
    expect(result.text).toBe("fix the bug");
  });

  it("parses directory entries with isFile=false", () => {
    const content =
      '<context>\n<directory path="src/lib" />\n</context>\ncheck this';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([fileEntry("src/lib", false)]);
  });

  it("parses a past_session entry", () => {
    const content = [
      "<context>",
      `<past_session task_id="${TASK_ID}">`,
      `Referenced session. A summary is injected at execution time; run \`chro task logs ${TASK_ID}\` for the full transcript.`,
      "</past_session>",
      "</context>",
      "continue please",
    ].join("\n");
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([sessionEntry(TASK_ID)]);
    expect(result.text).toBe("continue please");
  });

  it("parses a past_session entry with branch", () => {
    const content = [
      "<context>",
      `<past_session task_id="${TASK_ID}" branch="feature/x">`,
      "...",
      "</past_session>",
      "</context>",
      "go",
    ].join("\n");
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([sessionEntry(TASK_ID, "feature/x")]);
  });

  it("unescapes XML-encoded characters in paths", () => {
    const content =
      '<context>\n<file path="a&amp;b&lt;c&gt;d&quot;e.ts" />\n</context>\ntest';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([fileEntry('a&b<c>d"e.ts')]);
  });

  it("does not parse context block that appears mid-content", () => {
    const content = 'some text\n<context>\n<file path="a.ts" />\n</context>';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([]);
    expect(result.skillEntries).toEqual([]);
    expect(result.text).toBe(content);
  });

  it("parses a leading skills_context block", () => {
    const content = [
      "<skills_context>",
      '<skill id="workspace:.agents/skills:release" name="release" />',
      "</skills_context>",
      "ship it",
    ].join("\n");
    const result = parseContextFromContent(content);
    expect(result.skillEntries).toEqual([
      skillEntry("workspace:.agents/skills:release", "release"),
    ]);
    expect(result.text).toBe("ship it");
  });

  it("unescapes XML-encoded characters in skill entries", () => {
    const content =
      '<skills_context>\n<skill id="user:skills:a&amp;b&quot;c" name="docs &amp; &quot;notes&quot;" />\n</skills_context>\nreview';
    const result = parseContextFromContent(content);
    expect(result.skillEntries).toEqual([
      skillEntry('user:skills:a&b"c', 'docs & "notes"'),
    ]);
    expect(result.text).toBe("review");
  });

  it("parses context, skills, images, and text together", () => {
    const content = [
      '<context>\n<file path="src/main.ts" />\n</context>',
      '<skills_context>\n<skill id="workspace:.agents/skills:release" name="release" />\n</skills_context>',
      "![img.png](.chro-context/img.png)",
      "fix this",
    ].join("\n");
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([fileEntry("src/main.ts")]);
    expect(result.skillEntries).toEqual([
      skillEntry("workspace:.agents/skills:release", "release"),
    ]);
    expect(result.imageEntries).toEqual([
      { name: "img.png", path: ".chro-context/img.png" },
    ]);
    expect(result.text).toBe("fix this");
  });

  it("roundtrips file entries with formatContextForPrompt", () => {
    const entries: ContextEntry[] = [
      fileEntry("src/main.ts"),
      fileEntry("docs", false),
    ];
    const userText = "fix everything";
    const serialized = `${formatContextForPrompt(entries)}\n${userText}`;
    const result = parseContextFromContent(serialized);
    expect(result.contextEntries).toEqual(entries);
    expect(result.text).toBe(userText);
  });

  it("roundtrips session entries with formatContextForPrompt", () => {
    const entries: ContextEntry[] = [
      sessionEntry(TASK_ID, "feature/new-ui"),
      fileEntry("src/main.ts"),
    ];
    const userText = "compare with the old session";
    const serialized = `${formatContextForPrompt(entries)}\n${userText}`;
    const result = parseContextFromContent(serialized);
    expect(result.contextEntries).toEqual(entries);
    expect(result.text).toBe(userText);
  });

  it("roundtrips skill entries with formatSkillContextForPrompt", () => {
    const entries = [
      skillEntry("workspace:.agents/skills:release", "release"),
      skillEntry("user:.codex/skills:docs", "docs"),
    ];
    const userText = "use these";
    const serialized = `${formatSkillContextForPrompt(entries)}\n${userText}`;
    const result = parseContextFromContent(serialized);
    expect(result.skillEntries).toEqual(entries);
    expect(result.text).toBe(userText);
  });

  it("extracts image markdown into imageEntries", () => {
    const content = "![screenshot.png](.chro-context/abc.png)\nhello";
    const result = parseContextFromContent(content);
    expect(result.imageEntries).toEqual([
      { name: "screenshot.png", path: ".chro-context/abc.png" },
    ]);
    expect(result.text).toBe("hello");
  });

  it("extracts images alongside context entries", () => {
    const content =
      '<context>\n<file path="src/main.ts" />\n</context>\n![img.png](.chro-context/img.png)\nfix this';
    const result = parseContextFromContent(content);
    expect(result.contextEntries).toEqual([fileEntry("src/main.ts")]);
    expect(result.imageEntries).toEqual([
      { name: "img.png", path: ".chro-context/img.png" },
    ]);
    expect(result.text).toBe("fix this");
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

  it("ignores leading skill context", () => {
    const content =
      '<skills_context>\n<skill id="workspace:.agents/skills:release" name="release" />\n</skills_context>\nfix the release flow';
    expect(inferTaskTitleFromContent(content)).toBe("fix the release flow");
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

  it("returns null for skill-context-only prompts", () => {
    const content =
      '<skills_context>\n<skill id="workspace:.agents/skills:release" name="release" />\n</skills_context>';
    expect(inferTaskDescriptionFromContent(content)).toBeNull();
  });
});
