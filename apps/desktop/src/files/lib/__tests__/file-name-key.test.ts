import { describe, expect, it } from "vitest";
import { fileNameKey, fileNamesEqual } from "../file-name-key";

describe("fileNameKey", () => {
  it("folds NFD (macOS filesystem) and NFC (typed text) to the same key", () => {
    // "がき" precomposed vs "か" + combining voiced mark + "き".
    expect(fileNameKey("\u{304C}\u{304D}")).toBe(
      fileNameKey("\u{304B}\u{3099}\u{304D}"),
    );
    // "é" precomposed vs "e" + combining acute.
    expect(fileNameKey("caf\u{00E9}.md")).toBe(fileNameKey("cafe\u{0301}.md"));
  });

  it("is case-insensitive", () => {
    expect(fileNamesEqual("README.md", "readme.md")).toBe(true);
  });

  it("distinguishes genuinely different names", () => {
    expect(fileNamesEqual("note.md", "notes.md")).toBe(false);
  });
});
