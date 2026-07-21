import { describe, expect, it } from "vitest";

import { getCachedDocument, setCachedDocument } from "./cbase-document-cache";
import type { CbaseDocument } from "./types";

const doc = (name: string): CbaseDocument => ({
  properties: {},
  views: [],
  isQueryLanguage: false,
  definition: {
    version: 1,
    name,
    dataset: { include: ["**/*.md"] },
    properties: {},
    views: [],
  },
});

describe("cbase-document-cache", () => {
  it("returns a cached document only when the content matches", () => {
    const d = doc("A");
    setCachedDocument("p1", "a.cbase", "content-v1", d);

    expect(getCachedDocument("p1", "a.cbase", "content-v1")).toBe(d);
    // Stale content (file edited) must miss so it re-queries.
    expect(getCachedDocument("p1", "a.cbase", "content-v2")).toBeNull();
  });

  it("keys separately by project and path", () => {
    setCachedDocument("p1", "a.cbase", "c", doc("A"));
    setCachedDocument("p2", "a.cbase", "c", doc("B"));

    expect(getCachedDocument("p1", "a.cbase", "c")?.definition?.name).toBe("A");
    expect(getCachedDocument("p2", "a.cbase", "c")?.definition?.name).toBe("B");
    expect(getCachedDocument("p1", "b.cbase", "c")).toBeNull();
  });

  it("ignores missing project or path", () => {
    setCachedDocument(null, "a.cbase", "c", doc("A"));
    setCachedDocument("p1", undefined, "c", doc("A"));
    expect(getCachedDocument(null, "a.cbase", "c")).toBeNull();
    expect(getCachedDocument("p1", undefined, "c")).toBeNull();
  });
});
