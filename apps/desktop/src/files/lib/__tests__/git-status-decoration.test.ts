import type { GitStatus } from "@/lib/git-client";
import { describe, expect, it } from "vitest";
import { buildGitDecorations } from "../git-status-decoration";

const status = (overrides: Partial<GitStatus>): GitStatus => ({
  staged: [],
  modified: [],
  untracked: [],
  hasChanges: true,
  ...overrides,
});

describe("buildGitDecorations", () => {
  it("returns empty maps for null status", () => {
    const { files, folders } = buildGitDecorations(null);
    expect(files.size).toBe(0);
    expect(folders.size).toBe(0);
  });

  it("maps each changed file to its status", () => {
    const { files } = buildGitDecorations(
      status({
        modified: [{ path: "src/app.ts", status: "modified" }],
        untracked: ["src/new.ts"],
      }),
    );
    expect(files.get("src/app.ts")).toBe("modified");
    expect(files.get("src/new.ts")).toBe("untracked");
  });

  it("rolls status up to every ancestor folder", () => {
    const { folders } = buildGitDecorations(
      status({
        modified: [{ path: "apps/desktop/src/app.ts", status: "modified" }],
      }),
    );
    expect(folders.get("apps")).toBe("modified");
    expect(folders.get("apps/desktop")).toBe("modified");
    expect(folders.get("apps/desktop/src")).toBe("modified");
    // The file's own path is not a folder entry.
    expect(folders.has("apps/desktop/src/app.ts")).toBe(false);
  });

  it("picks the dominant status when a folder holds several changes", () => {
    const { folders } = buildGitDecorations(
      status({
        modified: [{ path: "src/a.ts", status: "modified" }],
        staged: [{ path: "src/b.ts", status: "deleted" }],
      }),
    );
    // deleted outranks modified
    expect(folders.get("src")).toBe("deleted");
  });

  it("normalizes leading slashes and backslashes", () => {
    const { files } = buildGitDecorations(
      status({ modified: [{ path: "/win\\path\\file.ts", status: "added" }] }),
    );
    expect(files.get("win/path/file.ts")).toBe("added");
  });
});
