import type { DesktopWorkspaceEntry } from "@/types/desktop";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LensDataset } from "../types";

vi.mock("@/lib/project-client", () => ({
  listProjectEntries: vi.fn(),
  readProjectFile: vi.fn(),
}));

import { listProjectEntries, readProjectFile } from "@/lib/project-client";
import { indexWorkspaceFiles } from "../indexer";

const listProjectEntriesMock = vi.mocked(listProjectEntries);
const readProjectFileMock = vi.mocked(readProjectFile);

describe("indexWorkspaceFiles (recursive listing)", () => {
  beforeEach(() => {
    listProjectEntriesMock.mockReset();
    readProjectFileMock.mockReset();
  });

  it("indexes nested files from recursive project entries", async () => {
    const dataset: LensDataset = {
      include: [".claude/skills/**/*.md"],
    };
    const entries: DesktopWorkspaceEntry[] = [
      {
        type: "directory",
        name: ".claude",
        displayName: ".claude",
        relativePath: ".claude",
        extension: null,
        children: [
          {
            type: "directory",
            name: "skills",
            displayName: "skills",
            relativePath: ".claude/skills",
            extension: null,
            children: [
              {
                type: "directory",
                name: "alpha",
                displayName: "alpha",
                relativePath: ".claude/skills/alpha",
                extension: null,
                children: [
                  {
                    type: "file",
                    name: "SKILL.md",
                    displayName: "SKILL",
                    relativePath: ".claude/skills/alpha/SKILL.md",
                    extension: "md",
                  },
                ],
              },
            ],
          },
        ],
      },
    ];

    listProjectEntriesMock.mockResolvedValue(entries);
    readProjectFileMock.mockResolvedValue({
      relativePath: ".claude/skills/alpha/SKILL.md",
      content: "---\ntitle: Alpha Skill\n---\nBody",
      size: 30,
      modifiedAt: null,
    });

    const rows = await indexWorkspaceFiles("project-1", dataset);

    expect(listProjectEntriesMock).toHaveBeenCalledWith("project-1", {
      recursive: true,
      detail: "basic",
    });
    expect(readProjectFileMock).toHaveBeenCalledWith(
      "project-1",
      ".claude/skills/alpha/SKILL.md",
    );
    expect(rows).toEqual([
      {
        filePath: ".claude/skills/alpha/SKILL.md",
        displayName: "SKILL",
        values: { title: "Alpha Skill" },
      },
    ]);
  });

  it("preserves modified timestamp metadata for table views", async () => {
    const dataset: LensDataset = {
      include: ["**/*.md"],
    };
    const entries: DesktopWorkspaceEntry[] = [
      {
        type: "file",
        name: "latest.md",
        displayName: "latest",
        relativePath: "latest.md",
        extension: "md",
        modifiedAt: "2026-02-26T05:49:25.000Z",
      },
    ];

    listProjectEntriesMock.mockResolvedValue(entries);
    readProjectFileMock.mockResolvedValue({
      relativePath: "latest.md",
      content: "---\ntitle: latest\n---\n",
      size: 10,
      modifiedAt: null,
    });

    const rows = await indexWorkspaceFiles("project-1", dataset);

    expect(rows).toEqual([
      {
        filePath: "latest.md",
        displayName: "latest",
        modifiedAt: "2026-02-26T05:49:25.000Z",
        values: { title: "latest" },
      },
    ]);
  });

  it("skips files that fail to read", async () => {
    const dataset: LensDataset = {
      include: ["**/*.md"],
    };
    const entries: DesktopWorkspaceEntry[] = [
      {
        type: "file",
        name: "ok.md",
        displayName: "ok",
        relativePath: "ok.md",
        extension: "md",
      },
      {
        type: "file",
        name: "bad.md",
        displayName: "bad",
        relativePath: "bad.md",
        extension: "md",
      },
    ];

    listProjectEntriesMock.mockResolvedValue(entries);
    readProjectFileMock.mockImplementation(async (_projectId, relativePath) => {
      if (relativePath === "bad.md") {
        throw new Error("read failed");
      }
      return {
        relativePath,
        content: "---\ntitle: ok\n---\n",
        size: 10,
        modifiedAt: null,
      };
    });

    const rows = await indexWorkspaceFiles("project-1", dataset);

    expect(rows).toEqual([
      {
        filePath: "ok.md",
        displayName: "ok",
        values: { title: "ok" },
      },
    ]);
  });
});
