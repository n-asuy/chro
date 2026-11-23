import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import { capsuleDotStatus, sessionDots } from "./capsule-dots";

let clock = 0;
/** A task created after every task made before it. */
function task(id: string, fields: Partial<StoredTask> = {}): StoredTask {
  clock += 1;
  const at = new Date(Date.UTC(2026, 10, 17, 9, 0, clock)).toISOString();
  return {
    id,
    project_id: "p1",
    title: id,
    status: "completed",
    created_at: at,
    updated_at: at,
    sort_order: 0,
    ...fields,
  };
}

const later = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 17, 10, minutes)).toISOString();

describe("capsuleDotStatus", () => {
  it("maps the session list's status marker onto the four dots", () => {
    expect(
      capsuleDotStatus(task("r", { active_session_id: "s" }), undefined),
    ).toBe("running");
    expect(
      capsuleDotStatus(
        task("w", { active_session_id: "s", awaiting_input: true }),
        undefined,
      ),
    ).toBe("waiting");
    expect(capsuleDotStatus(task("f", { status: "failed" }), undefined)).toBe(
      "waiting",
    );
    expect(capsuleDotStatus(task("d"), undefined)).toBe("done");
  });

  it("turns a finished session grey once read, and never drops it", () => {
    const done = task("d", { updated_at: later(0) });
    expect(capsuleDotStatus(done, later(1))).toBe("idle");
  });

  it("is grey for a failed session that was read, as the session list shows no marker", () => {
    const failed = task("f", { status: "failed", updated_at: later(0) });
    expect(capsuleDotStatus(failed, later(1))).toBe("idle");
  });

  it("is grey for a session that has not run and for one whose worktree was reclaimed", () => {
    expect(capsuleDotStatus(task("t", { status: "todo" }), undefined)).toBe(
      "idle",
    );
    expect(
      capsuleDotStatus(task("c", { worktree_deleted: true }), undefined),
    ).toBe("idle");
  });

  it("has no dot for an archived session", () => {
    expect(
      capsuleDotStatus(task("a", { status: "cancelled" }), undefined),
    ).toBeNull();
  });
});

describe("sessionDots", () => {
  it("lists every session that still exists, read or not, in creation order", () => {
    const a = task("a");
    const b = task("b", { status: "cancelled" });
    const c = task("c", { updated_at: later(0) });
    const dots = sessionDots([c, b, a], { c: later(1) });
    expect(dots.map((d) => [d.task.id, d.status])).toEqual([
      ["a", "done"],
      ["c", "idle"],
    ]);
  });
});
