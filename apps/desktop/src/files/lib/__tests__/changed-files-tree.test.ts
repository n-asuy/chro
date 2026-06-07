import { describe, expect, it } from "vitest";
import { FileNodeType } from "../../types/file-tree";
import {
  buildChangedFilesTree,
  collectDirectoryPaths,
} from "../changed-files-tree";

describe("buildChangedFilesTree", () => {
  it("nests changed files under synthesized, hydrated directories", () => {
    const tree = buildChangedFilesTree([
      "src/app.ts",
      "src/lib/util.ts",
      "README.md",
    ]);

    // Directories sort before files: src/ then README.md
    expect(tree.map((n) => n.name)).toEqual(["src", "README.md"]);

    const src = tree[0]!;
    expect(src.type).toBe(FileNodeType.Directory);
    expect(src.path).toBe("/src");
    expect(src.relativePath).toBe("src");
    expect(src.isHydrated).toBe(true);

    // src contains lib/ (dir) before app.ts (file)
    expect(src.children?.map((n) => n.name)).toEqual(["lib", "app.ts"]);
    const appFile = src.children?.find((n) => n.name === "app.ts");
    expect(appFile?.path).toBe("/src/app.ts");
    expect(appFile?.relativePath).toBe("src/app.ts");
  });

  it("does not duplicate a path that appears twice", () => {
    const tree = buildChangedFilesTree(["a.ts", "a.ts"]);
    expect(tree).toHaveLength(1);
  });

  it("collects every directory path for expand-all", () => {
    const tree = buildChangedFilesTree(["apps/desktop/src/app.ts"]);
    expect(collectDirectoryPaths(tree).sort()).toEqual([
      "/apps",
      "/apps/desktop",
      "/apps/desktop/src",
    ]);
  });
});
