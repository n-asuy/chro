import { describe, expect, it } from "vitest";
import {
  ancestorDirectories,
  buildDirectoryTree,
  directoryLastActivity,
  parentDirectory,
} from "../directory-tree";

describe("buildDirectoryTree", () => {
  it("nests entries under their directories with directories first", () => {
    const tree = buildDirectoryTree([
      { path: "README.md", isFile: true },
      { path: "apps", isFile: false },
      { path: "apps/desktop", isFile: false },
      { path: "apps/desktop/package.json", isFile: true },
      { path: "apps/cli", isFile: false },
      { path: ".github", isFile: false },
    ]);

    expect(tree.children.map((c) => c.name)).toEqual([
      ".github",
      "apps",
      "README.md",
    ]);
    const apps = tree.children[1];
    expect(apps.children.map((c) => c.name)).toEqual(["cli", "desktop"]);
    expect(apps.children[1].children).toEqual([
      {
        path: "apps/desktop/package.json",
        name: "package.json",
        isFile: true,
        children: [],
      },
    ]);
  });

  it("synthesizes directories the listing omits", () => {
    const tree = buildDirectoryTree([
      { path: "crates/server/src/lib.rs", isFile: true },
    ]);
    const crates = tree.children[0];
    expect(crates.path).toBe("crates");
    expect(crates.children[0].path).toBe("crates/server");
    expect(crates.children[0].children[0].path).toBe("crates/server/src");
    expect(crates.children[0].children[0].children[0].isFile).toBe(true);
  });

  it("normalizes separators and ignores the root entry", () => {
    const tree = buildDirectoryTree([
      { path: "", isFile: false },
      { path: "/docs/", isFile: false },
      { path: "docs\\a.md", isFile: true },
    ]);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].path).toBe("docs");
    expect(tree.children[0].children[0].path).toBe("docs/a.md");
  });

  it("sorts descending at every depth while keeping directories before files", () => {
    const tree = buildDirectoryTree(
      [
        { path: "docs/a.md", isFile: true },
        { path: "docs/z.md", isFile: true },
        { path: "docs/nested/b.md", isFile: true },
        { path: "apps", isFile: false },
        { path: "README.md", isFile: true },
      ],
      "name-desc",
    );
    expect(tree.children.map((node) => node.name)).toEqual([
      "docs",
      "apps",
      "README.md",
    ]);
    expect(tree.children[0].children.map((node) => node.name)).toEqual([
      "nested",
      "z.md",
      "a.md",
    ]);
  });

  it("orders directories by descendant session activity with alphabetical ties", () => {
    const latest = directoryLastActivity([
      { home_dir: "docs/japanese", updated_at: "2026-09-23T10:00:00Z" },
      { home_dir: "apps", updated_at: "2026-09-22T10:00:00Z" },
      { home_dir: "docs", updated_at: "2026-09-20T10:00:00Z" },
      { home_dir: "archive", updated_at: "invalid" },
      { home_dir: null, updated_at: "2026-09-24T10:00:00Z" },
    ]);
    const tree = buildDirectoryTree(
      [
        { path: "apps", isFile: false },
        { path: "archive", isFile: false },
        { path: "docs/alpha.md", isFile: true },
        { path: "docs/zulu.md", isFile: true },
        { path: "docs/aaa", isFile: false },
        { path: "docs/japanese", isFile: false },
        { path: "empty", isFile: false },
      ],
      "recent",
      latest,
    );
    expect(tree.children.map((node) => node.name)).toEqual([
      "docs",
      "apps",
      "archive",
      "empty",
    ]);
    expect(tree.children[0].children.map((node) => node.name)).toEqual([
      "japanese",
      "aaa",
      "alpha.md",
      "zulu.md",
    ]);
    expect(latest.get("")).toBe(Date.parse("2026-09-23T10:00:00Z"));
  });
});

describe("path helpers", () => {
  it("parentDirectory returns the root for top-level entries", () => {
    expect(parentDirectory("README.md")).toBe("");
    expect(parentDirectory("apps/desktop/src")).toBe("apps/desktop");
    expect(parentDirectory("")).toBe("");
  });

  it("ancestorDirectories lists the chain from the root", () => {
    expect(ancestorDirectories("")).toEqual([""]);
    expect(ancestorDirectories("apps/desktop/src")).toEqual([
      "",
      "apps",
      "apps/desktop",
      "apps/desktop/src",
    ]);
  });
});
