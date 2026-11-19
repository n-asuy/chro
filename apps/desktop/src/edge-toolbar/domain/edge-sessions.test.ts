import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import {
  type EdgeSession,
  deriveEdgeSessionState,
  edgeDotStatus,
  edgeSessions,
  nextUnreadOrder,
  pagerIndicator,
  panelSessionState,
  resolveCursor,
  stepCursor,
  unreadBadge,
} from "./edge-sessions";

function task(id: string, fields: Partial<StoredTask> = {}): StoredTask {
  return {
    id,
    project_id: "p1",
    title: id,
    status: "completed",
    created_at: "2026-11-17T09:00:00.000Z",
    updated_at: "2026-11-17T10:00:00.000Z",
    sort_order: 0,
    ...fields,
  };
}

const running = (id: string, fields: Partial<StoredTask> = {}) =>
  task(id, { status: "running", active_session_id: `s-${id}`, ...fields });
const waiting = (id: string, fields: Partial<StoredTask> = {}) =>
  running(id, { awaiting_input: true, ...fields });

function session(t: StoredTask, viewed: Record<string, string> = {}) {
  const state = deriveEdgeSessionState(t, viewed[t.id]);
  if (!state) throw new Error(`${t.id} has no edge state`);
  return { task: t, state } satisfies EdgeSession;
}

describe("deriveEdgeSessionState", () => {
  it("is waiting while the agent is blocked on the user, even mid-run", () => {
    expect(deriveEdgeSessionState(waiting("a"), undefined)).toBe("waiting");
  });

  it("is running while a run is live", () => {
    expect(deriveEdgeSessionState(running("a"), undefined)).toBe("running");
  });

  it("reports a finished result the user has not seen", () => {
    expect(deriveEdgeSessionState(task("a"), undefined)).toBe("completed");
    expect(
      deriveEdgeSessionState(task("a", { status: "failed" }), undefined),
    ).toBe("failed");
  });

  it("drops a finished session once it was viewed after it finished", () => {
    expect(
      deriveEdgeSessionState(task("a"), "2026-11-17T10:00:01.000Z"),
    ).toBeNull();
  });

  it("never shows an archived session", () => {
    expect(
      deriveEdgeSessionState(
        task("a", { status: "cancelled", awaiting_input: true }),
        undefined,
      ),
    ).toBeNull();
  });
});

describe("edgeSessions", () => {
  it("lists sessions oldest first, so a new one joins at the end and no dot moves", () => {
    const tasks = [
      running("old", {
        created_at: "2026-11-17T08:00:00.000Z",
        updated_at: "2026-11-17T12:00:00.000Z",
      }),
      running("new", {
        created_at: "2026-11-17T09:00:00.000Z",
        updated_at: "2026-11-17T09:30:00.000Z",
      }),
      task("seen"),
    ];

    const result = edgeSessions(tasks, { seen: "2026-11-17T11:00:00.000Z" });

    expect(result.map((s) => s.task.id)).toEqual(["old", "new"]);
  });
});

describe("panelSessionState", () => {
  it("names where any session is, read or not, for the panel's status line", () => {
    expect(panelSessionState(waiting("a"))).toBe("waiting");
    expect(panelSessionState(running("a"))).toBe("running");
    expect(panelSessionState(task("a", { status: "failed" }))).toBe("failed");
    expect(panelSessionState(task("a"))).toBe("completed");
    expect(panelSessionState(task("a", { status: "todo" }))).toBe("completed");
  });
});

describe("edgeDotStatus", () => {
  it("draws amber for anything that needs the user, a failure included, green when finished, the spinner when running", () => {
    expect(edgeDotStatus("waiting")).toBe("waiting");
    expect(edgeDotStatus("failed")).toBe("waiting");
    expect(edgeDotStatus("running")).toBe("running");
    expect(edgeDotStatus("completed")).toBe("done");
  });
});

describe("unreadBadge", () => {
  const sessions = [
    session(task("done")),
    session(running("r")),
    session(task("bad", { status: "failed" })),
    session(waiting("w")),
  ];

  it("counts sessions waiting on the user and unseen results, not running ones", () => {
    expect(unreadBadge(sessions, null)?.count).toBe(3);
  });

  it("is absent when nothing needs the user", () => {
    expect(unreadBadge([session(running("r"))], null)).toBeNull();
  });

  it("is amber while something needs the user (a question or a failure), green when results only finished", () => {
    expect(unreadBadge(sessions, null)?.status).toBe("waiting");
    expect(unreadBadge(sessions.slice(0, 3), null)?.status).toBe("waiting");
    expect(unreadBadge(sessions.slice(0, 1), null)?.status).toBe("done");
  });

  it("counts what the open pager lists, so the badge and the pager agree after an item is read", () => {
    // "done" was shown, so it is read and no longer an edge session, yet the
    // pager keeps it in place until it closes.
    const afterRead = sessions.filter((s) => s.task.id !== "done");
    const pager = { order: ["w", "bad", "done"], cursorId: "done" };
    expect(unreadBadge(afterRead, pager)?.count).toBe(3);
  });

  it("follows the item the pager shows while it is still unread", () => {
    const pager = { order: ["w", "bad", "done"], cursorId: "done" };
    expect(unreadBadge(sessions, pager)?.status).toBe("done");
  });

  it("falls back to the most urgent listed item once the shown one is read", () => {
    const afterRead = sessions.filter((s) => s.task.id !== "done");
    const pager = { order: ["bad", "done"], cursorId: "done" };
    expect(unreadBadge(afterRead, pager)?.status).toBe("waiting");
  });
});

describe("pagerIndicator", () => {
  it("is absent for a single item", () => {
    expect(pagerIndicator(["a"], "a", 7)).toBeNull();
    expect(pagerIndicator([], null, 7)).toBeNull();
  });

  it("is a row of dots with the current one marked while they fit", () => {
    expect(pagerIndicator(["a", "b", "c", "d"], "c", 7)).toEqual({
      kind: "dots",
      total: 4,
      index: 2,
    });
  });

  it("becomes a position count when there are more items than dots", () => {
    const order = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(pagerIndicator(order, "b", 7)).toEqual({
      kind: "count",
      total: 8,
      index: 1,
    });
  });

  it("marks nothing when the cursor is not in the list", () => {
    expect(pagerIndicator(["a", "b"], null, 7)).toEqual({
      kind: "dots",
      total: 2,
      index: -1,
    });
  });
});

/** Every task in `sessions` (plus `alsoExisting`) still exists. */
function order(
  previous: string[],
  sessions: EdgeSession[],
  shown: Set<string>,
  alsoExisting: string[] = [],
) {
  return nextUnreadOrder({
    previous,
    sessions,
    shown,
    existing: new Set([...sessions.map((s) => s.task.id), ...alsoExisting]),
  });
}

describe("nextUnreadOrder", () => {
  it("puts sessions waiting on a question or approval first, then unseen results", () => {
    const sessions = [
      session(task("done-early", { updated_at: "2026-11-17T09:00:00.000Z" })),
      session(waiting("w-late", { updated_at: "2026-11-17T11:00:00.000Z" })),
      session(task("done-late", { updated_at: "2026-11-17T12:00:00.000Z" })),
      session(waiting("w-early", { updated_at: "2026-11-17T08:00:00.000Z" })),
      session(running("r")),
    ];

    const prior = order([], sessions, new Set());

    // Longest-waiting first, then the most recent result first.
    expect(prior).toEqual(["w-early", "w-late", "done-late", "done-early"]);
  });

  it("keeps a shown result in place after it was read, until the pager closes", () => {
    const before = [session(waiting("w")), session(task("done"))];
    const prior = order([], before, new Set());

    // `done` was shown, so it was marked read and no longer needs the user.
    const after = [session(waiting("w"))];

    expect(order(prior, after, new Set(["done"]), ["done"])).toEqual([
      "w",
      "done",
    ]);
  });

  it("keeps an answered question in place while the pager is open", () => {
    const prior = order([], [session(waiting("w"))], new Set());

    // Answered: the agent runs again and no longer needs the user.
    const answered = [session(running("w"))];

    expect(order(prior, answered, new Set(["w"]))).toEqual(["w"]);
  });

  it("drops an item that was never shown once it no longer needs the user", () => {
    const prior = order(
      [],
      [session(waiting("w")), session(task("done"))],
      new Set(),
    );

    // Answered in the session window before the pager reached it.
    expect(
      order(
        prior,
        [session(running("w")), session(running("done"))],
        new Set(),
      ),
    ).toEqual([]);
  });

  it("inserts a newly waiting session after the waiting ones, ahead of results", () => {
    const prior = order(
      [],
      [session(waiting("w1")), session(task("done"))],
      new Set(),
    );

    const next = order(
      prior,
      [session(waiting("w1")), session(task("done")), session(waiting("w2"))],
      new Set(),
    );

    expect(next).toEqual(["w1", "w2", "done"]);
  });

  it("returns the previous order itself when nothing changed", () => {
    const sessions = [session(waiting("w")), session(task("done"))];
    const prior = order([], sessions, new Set());

    expect(order(prior, sessions, new Set())).toBe(prior);
  });

  it("forgets a session that was deleted", () => {
    const prior = order([], [session(task("gone"))], new Set());
    expect(order(prior, [], new Set(["gone"]))).toEqual([]);
  });
});

describe("resolveCursor", () => {
  it("stays on the current item when others are inserted around it", () => {
    expect(resolveCursor(["n", "a", "b"], "a", 0)).toBe("a");
  });

  it("starts at the first item", () => {
    expect(resolveCursor(["a", "b"], null, 0)).toBe("a");
  });

  it("moves to the item that took the place of one that left", () => {
    expect(resolveCursor(["a", "c"], "b", 1)).toBe("c");
    expect(resolveCursor(["a"], "b", 1)).toBe("a");
  });

  it("is empty for an empty list", () => {
    expect(resolveCursor([], "a", 0)).toBeNull();
  });
});

describe("stepCursor", () => {
  it("moves by one and stops at the ends", () => {
    expect(stepCursor(["a", "b", "c"], "a", 1)).toBe("b");
    expect(stepCursor(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepCursor(["a", "b", "c"], "a", -1)).toBe("a");
  });
});
