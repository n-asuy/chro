import { describe, expect, it } from "vitest";

import { minimalChange } from "./minimal-change";

describe("minimalChange", () => {
  it("returns null when nothing changed", () => {
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("limits an insertion to the inserted text", () => {
    expect(minimalChange("ab\ncd", "ab\nXcd")).toEqual({
      from: 3,
      to: 3,
      insert: "X",
    });
  });

  it("limits a replacement to the differing middle", () => {
    expect(minimalChange("one two three", "one 2 three")).toEqual({
      from: 4,
      to: 7,
      insert: "2",
    });
  });

  it("handles a deletion at the end", () => {
    expect(minimalChange("abc", "a")).toEqual({ from: 1, to: 3, insert: "" });
  });

  it("does not let prefix and suffix overlap on repeated text", () => {
    expect(minimalChange("aaa", "aaaa")).toEqual({
      from: 3,
      to: 3,
      insert: "a",
    });
  });
});
