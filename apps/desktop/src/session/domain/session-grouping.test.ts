import { describe, expect, it } from "vitest";
import type { StoredTask } from "../types";
import { sortPinnedSessions } from "./session-grouping";

function task(id: string, over: Partial<StoredTask> = {}): StoredTask {
  return {
    id,
    project_id: "p",
    title: id,
    status: "completed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    sort_order: 0,
    ...over,
  };
}

describe("sortPinnedSessions", () => {
  it("floats needs-input above failed above the rest, ignoring pin time", () => {
    const calm = task("calm", { status: "completed" });
    const failed = task("failed", { status: "failed" });
    const waiting = task("waiting", { awaiting_input: true });
    // Pin times deliberately inverted: the calmest was pinned most recently.
    const pins = {
      waiting: "2026-01-01T00:00:00.000Z",
      failed: "2026-01-02T00:00:00.000Z",
      calm: "2026-01-03T00:00:00.000Z",
    };

    const order = sortPinnedSessions([calm, failed, waiting], pins).map(
      (t) => t.id,
    );

    expect(order).toEqual(["waiting", "failed", "calm"]);
  });

  it("orders same-urgency items by most-recently-pinned first", () => {
    const older = task("older");
    const newer = task("newer");
    const pins = {
      older: "2026-01-01T00:00:00.000Z",
      newer: "2026-01-05T00:00:00.000Z",
    };

    const order = sortPinnedSessions([older, newer], pins).map((t) => t.id);

    expect(order).toEqual(["newer", "older"]);
  });

  it("treats missing or unparseable pin times as oldest", () => {
    const pinned = task("pinned");
    const unpinned = task("unpinned");
    const pins = { pinned: "2026-01-01T00:00:00.000Z", unpinned: "not-a-date" };

    const order = sortPinnedSessions([unpinned, pinned], pins).map((t) => t.id);

    expect(order).toEqual(["pinned", "unpinned"]);
  });

  it("does not mutate the input array", () => {
    const input = [task("b"), task("a")];
    const snapshot = input.map((t) => t.id);
    sortPinnedSessions(input, {});
    expect(input.map((t) => t.id)).toEqual(snapshot);
  });
});
