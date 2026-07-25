import { describe, expect, it } from "vitest";
import {
  DIFF_EXPAND_BATCH_SIZE,
  MAX_RENDERED_DIFF_BYTES,
  bulkExpandedDiffIds,
  shouldBuildInlineDiff,
} from "./diff-render-policy";

const base = {
  expanded: true,
  isImage: false,
  isContentEqual: false,
  isOmitted: false,
  oldContent: "before",
  newContent: "after",
};

describe("diff render policy", () => {
  it("does not build collapsed diff bodies", () => {
    expect(shouldBuildInlineDiff({ ...base, expanded: false })).toBe(false);
  });

  it("does not build oversized diff bodies", () => {
    expect(
      shouldBuildInlineDiff({
        ...base,
        oldContent: "x".repeat(MAX_RENDERED_DIFF_BYTES),
        newContent: "y",
      }),
    ).toBe(false);
  });

  it("limits bulk expansion to a safe batch", () => {
    const ids = Array.from(
      { length: DIFF_EXPAND_BATCH_SIZE + 10 },
      (_, index) => `file-${index}`,
    );
    expect([...bulkExpandedDiffIds(ids)]).toEqual(
      ids.slice(0, DIFF_EXPAND_BATCH_SIZE),
    );
  });
});
