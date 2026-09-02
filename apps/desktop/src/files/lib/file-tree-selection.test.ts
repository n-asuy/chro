import { describe, expect, it } from "vitest";
import {
  getContextSelectionPaths,
  getObsidianPointerSelectionMode,
  getVisibleRangePaths,
  normalizeFileOperationPaths,
} from "./file-tree-selection";

describe("getVisibleRangePaths", () => {
  const paths = ["/a.md", "/b.md", "/folder", "/folder/c.md"];

  it("selects an inclusive range in either direction", () => {
    expect(getVisibleRangePaths(paths, "/a.md", "/folder")).toEqual([
      "/a.md",
      "/b.md",
      "/folder",
    ]);
    expect(getVisibleRangePaths(paths, "/folder", "/a.md")).toEqual([
      "/a.md",
      "/b.md",
      "/folder",
    ]);
  });

  it("falls back to the target when the anchor is hidden", () => {
    expect(getVisibleRangePaths(paths, "/hidden.md", "/b.md")).toEqual([
      "/b.md",
    ]);
  });
});

describe("normalizeFileOperationPaths", () => {
  it("deduplicates paths while preserving their order", () => {
    expect(normalizeFileOperationPaths(["/b.md", "/a.md", "/b.md"])).toEqual([
      "/b.md",
      "/a.md",
    ]);
  });

  it("drops descendants when their ancestor is selected", () => {
    expect(
      normalizeFileOperationPaths(["/folder/child.md", "/folder", "/other.md"]),
    ).toEqual(["/folder", "/other.md"]);
  });
});

describe("getContextSelectionPaths", () => {
  it("keeps the selection when the context target belongs to it", () => {
    expect(getContextSelectionPaths(["/a.md", "/b.md"], "/b.md")).toEqual([
      "/a.md",
      "/b.md",
    ]);
  });

  it("replaces the selection for an unselected context target", () => {
    expect(getContextSelectionPaths(["/a.md", "/b.md"], "/c.md")).toEqual([
      "/c.md",
    ]);
  });
});

describe("getObsidianPointerSelectionMode", () => {
  it("uses Alt/Option for discontinuous selection", () => {
    expect(
      getObsidianPointerSelectionMode({
        altKey: true,
        shiftKey: false,
        primaryModifierKey: false,
      }),
    ).toBe("toggle");
  });

  it("uses Shift for a contiguous range", () => {
    expect(
      getObsidianPointerSelectionMode({
        altKey: false,
        shiftKey: true,
        primaryModifierKey: false,
      }),
    ).toBe("range");
  });

  it("preserves selection for Cmd/Ctrl opening gestures", () => {
    expect(
      getObsidianPointerSelectionMode({
        altKey: false,
        shiftKey: false,
        primaryModifierKey: true,
      }),
    ).toBe("preserve");
  });
});
