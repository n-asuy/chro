import { describe, expect, it } from "vitest";
import type { DiffContent } from "@/session/hooks/use-task-log-stream";
import { changeBaseText, resolveChangeBase } from "./change-base";

const diff = (patch: Partial<DiffContent>): DiffContent =>
  ({
    change: "modified",
    old_content: "before",
    new_content: "after",
    ...patch,
  }) as DiffContent;

describe("resolveChangeBase", () => {
  it("uses the diff's base text for a changed file, whatever the slashes", () => {
    expect(
      resolveChangeBase({
        path: "/docs/a.md",
        diffs: [{ path: "docs/a.md", diff: diff({}) }],
        isLoading: false,
      }),
    ).toEqual({ kind: "changed", base: "before" });
  });

  it("treats an added file as changed from nothing", () => {
    expect(
      resolveChangeBase({
        path: "a.md",
        diffs: [
          {
            path: "a.md",
            diff: diff({ change: "added", old_content: undefined }),
          },
        ],
        isLoading: false,
      }),
    ).toEqual({ kind: "changed", base: "" });
  });

  it("waits for the diff before calling a file unchanged", () => {
    expect(
      resolveChangeBase({ path: "a.md", diffs: [], isLoading: true }),
    ).toEqual({
      kind: "unknown",
    });
    expect(
      resolveChangeBase({ path: "a.md", diffs: [], isLoading: false }),
    ).toEqual({
      kind: "unchanged",
    });
  });

  it("gives up on content the diff did not carry", () => {
    expect(
      resolveChangeBase({
        path: "a.md",
        diffs: [{ path: "a.md", diff: diff({ content_omitted: true }) }],
        isLoading: false,
      }),
    ).toEqual({ kind: "unavailable" });
  });
});

describe("changeBaseText", () => {
  it("compares an unchanged file with its disk text", () => {
    expect(changeBaseText({ kind: "unchanged" }, "disk")).toBe("disk");
    expect(changeBaseText({ kind: "changed", base: "head" }, "disk")).toBe(
      "head",
    );
    expect(changeBaseText({ kind: "unknown" }, "disk")).toBeNull();
    expect(changeBaseText({ kind: "unavailable" }, "disk")).toBeNull();
  });
});
