import { describe, expect, it } from "vitest";
import { looksLikeFilePath, normalizeFilePathHref } from "../file-path-utils";

describe("looksLikeFilePath", () => {
  it("accepts the path shapes agents actually write", () => {
    for (const candidate of [
      "src/main.rs",
      "./scripts/build.mjs",
      "/Users/alice/Desktop/today",
      "~/workspace/report.html",
      "C:/Users/alice/notes.md",
      "README.md",
      "docs/20260816_調査.html",
      "~/Documents/My Notes/draft one.md",
    ]) {
      expect(looksLikeFilePath(candidate), candidate).toBe(true);
    }
  });

  it("rejects text that cannot name a path", () => {
    for (const candidate of [
      "",
      "useState",
      "https://chro-ai.com/docs",
      "#heading",
      "/",
      "`quoted`",
      'git commit -m "message"',
      // Prose: more spaces than any real name carries.
      "run the build and then open the report",
      "a\nb",
    ]) {
      expect(looksLikeFilePath(candidate), candidate).toBe(false);
    }
  });
});

describe("path reference normalization", () => {
  it("decodes escaped path characters", () => {
    expect(normalizeFilePathHref("/Users/alice/My%20Folder")).toBe(
      "/Users/alice/My Folder",
    );
  });
});
