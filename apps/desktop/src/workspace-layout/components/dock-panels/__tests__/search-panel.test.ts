import { describe, expect, it } from "vitest";
import {
  parseTrailingOperator,
  stepSuggestionIndex,
} from "../search-panel";

describe("parseTrailingOperator", () => {
  it("returns null for a plain query, so the completion popup never opens", () => {
    expect(parseTrailingOperator("readme design")).toBeNull();
    expect(parseTrailingOperator("")).toBeNull();
    // A completed value followed by a space is no longer a trailing operator.
    expect(parseTrailingOperator("file:README.md ")).toBeNull();
  });

  it("detects a trailing file:/path: operator and its partial", () => {
    expect(parseTrailingOperator("file:read")).toEqual({
      field: "file",
      partial: "read",
      start: 0,
    });
    expect(parseTrailingOperator("foo path:src/li")).toEqual({
      field: "path",
      partial: "src/li",
      start: 4,
    });
  });

  it("treats an empty partial (just `file:`) as active", () => {
    expect(parseTrailingOperator("file:")).toEqual({
      field: "file",
      partial: "",
      start: 0,
    });
  });
});

describe("stepSuggestionIndex", () => {
  const LEN = 3; // indices 0,1,2

  it("cycles down through the list then back to -1 (free input)", () => {
    expect(stepSuggestionIndex(-1, LEN, 1)).toBe(0);
    expect(stepSuggestionIndex(0, LEN, 1)).toBe(1);
    expect(stepSuggestionIndex(2, LEN, 1)).toBe(-1); // past last → free input
  });

  it("cycles up, wrapping from -1 to the last item", () => {
    expect(stepSuggestionIndex(1, LEN, -1)).toBe(0);
    expect(stepSuggestionIndex(0, LEN, -1)).toBe(-1); // back to free input
    expect(stepSuggestionIndex(-1, LEN, -1)).toBe(2); // wrap to last
  });

  it("stays at -1 for an empty list", () => {
    expect(stepSuggestionIndex(-1, 0, 1)).toBe(-1);
    expect(stepSuggestionIndex(-1, 0, -1)).toBe(-1);
  });
});
