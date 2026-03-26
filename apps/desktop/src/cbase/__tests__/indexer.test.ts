import { describe, it, expect } from "vitest";
import { matchesDataset } from "../glob";
import type { LensDataset } from "../types";

describe("matchesDataset", () => {
  it("matches simple glob", () => {
    const dataset: LensDataset = { include: ["*.md"] };
    expect(matchesDataset("note.md", dataset)).toBe(true);
    expect(matchesDataset("note.txt", dataset)).toBe(false);
  });

  it("matches directory glob", () => {
    const dataset: LensDataset = { include: ["tasks/**/*.md"] };
    expect(matchesDataset("tasks/todo.md", dataset)).toBe(true);
    expect(matchesDataset("tasks/sub/todo.md", dataset)).toBe(true);
    expect(matchesDataset("other/todo.md", dataset)).toBe(false);
  });

  it("handles exclude patterns", () => {
    const dataset: LensDataset = {
      include: ["**/*.md"],
      exclude: ["templates/**"],
    };
    expect(matchesDataset("note.md", dataset)).toBe(true);
    expect(matchesDataset("templates/default.md", dataset)).toBe(false);
  });

  it("handles multiple include patterns", () => {
    const dataset: LensDataset = {
      include: ["tasks/**/*.md", "issues/**/*.md"],
    };
    expect(matchesDataset("tasks/t1.md", dataset)).toBe(true);
    expect(matchesDataset("issues/i1.md", dataset)).toBe(true);
    expect(matchesDataset("notes/n1.md", dataset)).toBe(false);
  });

  it("single star does not match path separators", () => {
    const dataset: LensDataset = { include: ["tasks/*.md"] };
    expect(matchesDataset("tasks/todo.md", dataset)).toBe(true);
    expect(matchesDataset("tasks/sub/todo.md", dataset)).toBe(false);
  });
});
