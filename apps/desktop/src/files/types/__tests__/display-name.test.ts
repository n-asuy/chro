import { describe, expect, it } from "vitest";
import { FileNodeType, getDisplayName } from "../file-tree";

describe("getDisplayName", () => {
  it("hides the extension of formats chro renders as documents", () => {
    for (const [name, expected] of [
      ["Design.md", "Design"],
      ["notes.markdown", "notes"],
      ["sketch.excalidraw", "sketch"],
      ["tasks.cbase", "tasks"],
      ["README.MD", "README"],
    ]) {
      expect(getDisplayName(name, FileNodeType.File)).toBe(expected);
    }
  });

  it("keeps the extension of every other file", () => {
    // Stripping any extension would collide these two.
    expect(getDisplayName("main.rs", FileNodeType.File)).toBe("main.rs");
    expect(getDisplayName("main.ts", FileNodeType.File)).toBe("main.ts");
    expect(getDisplayName("archive.tar.gz", FileNodeType.File)).toBe(
      "archive.tar.gz",
    );
  });

  it("treats a leading dot as part of the name", () => {
    expect(getDisplayName(".gitignore", FileNodeType.File)).toBe(".gitignore");
    expect(getDisplayName(".md", FileNodeType.File)).toBe(".md");
  });

  it("never hides anything for a directory", () => {
    expect(getDisplayName("release.md", FileNodeType.Directory)).toBe(
      "release.md",
    );
  });
});
