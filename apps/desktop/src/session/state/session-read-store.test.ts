import { describe, expect, it } from "vitest";
import { mergeViewedMaps } from "./session-read-store";

describe("mergeViewedMaps", () => {
  it("adds marks made in another window", () => {
    expect(
      mergeViewedMaps({ a: "2026-11-17T10:00:00.000Z" }, { b: "2026-11-17T11:00:00.000Z" }),
    ).toEqual({ a: "2026-11-17T10:00:00.000Z", b: "2026-11-17T11:00:00.000Z" });
  });

  it("keeps the later mark, so a cleared dot never comes back", () => {
    const current = { a: "2026-11-17T12:00:00.000Z" };
    expect(mergeViewedMaps(current, { a: "2026-11-17T09:00:00.000Z" })).toBe(
      current,
    );
    expect(
      mergeViewedMaps(current, { a: "2026-11-17T13:00:00.000Z" }),
    ).toEqual({ a: "2026-11-17T13:00:00.000Z" });
  });

  it("returns the current map itself when nothing is new", () => {
    const current = { a: "2026-11-17T12:00:00.000Z" };
    expect(mergeViewedMaps(current, {})).toBe(current);
    expect(mergeViewedMaps(current, { ...current })).toBe(current);
  });
});
