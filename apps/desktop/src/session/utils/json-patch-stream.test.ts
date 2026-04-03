import { describe, expect, it } from "vitest";

import { dedupeJsonPatchOperations } from "./json-patch-stream";

describe("dedupeJsonPatchOperations", () => {
  it("keeps only the last operation for a path", () => {
    expect(
      dedupeJsonPatchOperations([
        { op: "add", path: "/entries/0" },
        { op: "replace", path: "/entries/0" },
        { op: "add", path: "/entries/1" },
      ]),
    ).toEqual([
      { op: "replace", path: "/entries/0" },
      { op: "add", path: "/entries/1" },
    ]);
  });
});
