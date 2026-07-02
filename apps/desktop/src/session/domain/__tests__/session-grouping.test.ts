import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import {
  type GroupLabels,
  type SessionGroupMode,
  deriveDateBucket,
  deriveSessionState,
  groupSessions,
  isInboxSession,
  isSessionGroupMode,
} from "../session-grouping";

const LABELS: GroupLabels = {
  state: {
    needs_input: "Needs input",
    running: "Running",
    pending: "Pending",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  dateBucket: {
    today: "Today",
    yesterday: "Yesterday",
    last7: "Previous 7 days",
    last30: "Previous 30 days",
    older: "Older",
  },
  unknownProject: "Unknown project",
};

function task(overrides: Partial<StoredTask> & { id: string }): StoredTask {
  return {
    project_id: "p1",
    title: overrides.id,
    status: "pending",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    sort_order: 0,
    ...overrides,
  };
}

describe("isSessionGroupMode", () => {
  it("accepts known modes and rejects others", () => {
    for (const mode of ["none", "project", "status", "date"]) {
      expect(isSessionGroupMode(mode)).toBe(true);
    }
    expect(isSessionGroupMode("inbox")).toBe(false);
    expect(isSessionGroupMode(null)).toBe(false);
    expect(isSessionGroupMode(undefined)).toBe(false);
  });
});

describe("deriveSessionState", () => {
  it("prioritizes awaiting input over running", () => {
    expect(
      deriveSessionState(
        task({ id: "a", awaiting_input: true, active_session_id: "run" }),
      ),
    ).toBe("needs_input");
  });

  it("treats an active session as running regardless of stored status", () => {
    expect(
      deriveSessionState(
        task({ id: "a", active_session_id: "run", status: "pending" }),
      ),
    ).toBe("running");
  });

  it("maps stored status when idle", () => {
    expect(deriveSessionState(task({ id: "a", status: "completed" }))).toBe(
      "completed",
    );
    expect(deriveSessionState(task({ id: "a", status: "failed" }))).toBe(
      "failed",
    );
    expect(deriveSessionState(task({ id: "a", status: "cancelled" }))).toBe(
      "cancelled",
    );
    expect(deriveSessionState(task({ id: "a", status: "in_progress" }))).toBe(
      "running",
    );
    expect(deriveSessionState(task({ id: "a", status: "pending" }))).toBe(
      "pending",
    );
  });
});

describe("deriveDateBucket", () => {
  // Buckets are computed against the *local* start-of-day, so build fixtures
  // from local calendar parts (and round-trip through ISO) to stay TZ-safe.
  const iso = (...parts: [number, number, number, number, number]) =>
    new Date(parts[0], parts[1], parts[2], parts[3], parts[4]).toISOString();
  const now = new Date(2026, 5, 27, 10, 0).getTime(); // 2026-06-27 10:00 local

  it("buckets by calendar distance from the start of today", () => {
    expect(deriveDateBucket(iso(2026, 5, 27, 0, 30), now)).toBe("today");
    expect(deriveDateBucket(iso(2026, 5, 26, 23, 0), now)).toBe("yesterday");
    expect(deriveDateBucket(iso(2026, 5, 23, 12, 0), now)).toBe("last7");
    expect(deriveDateBucket(iso(2026, 5, 10, 12, 0), now)).toBe("last30");
    expect(deriveDateBucket(iso(2026, 0, 1, 12, 0), now)).toBe("older");
  });

  it("falls back to older for an unparseable timestamp", () => {
    expect(deriveDateBucket("not-a-date", now)).toBe("older");
  });
});

const baseArgs = {
  projectNames: { p1: "Alpha", p2: "Beta" },
  now: new Date("2026-06-27T10:00:00.000Z").getTime(),
  labels: LABELS,
};

describe("groupSessions — none", () => {
  it("returns a single headerless group preserving input order", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" })];
    const groups = groupSessions({ ...baseArgs, mode: "none", tasks });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("all");
    expect(groups[0].label).toBe("");
    expect(groups[0].projectId).toBeNull();
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

describe("groupSessions — project", () => {
  it("buckets by project and resolves the project name", () => {
    const tasks = [
      task({ id: "a", project_id: "p1" }),
      task({ id: "b", project_id: "p2" }),
      task({ id: "c", project_id: "p1" }),
    ];
    const groups = groupSessions({ ...baseArgs, mode: "project", tasks });
    const p1 = groups.find((g) => g.projectId === "p1");
    const p2 = groups.find((g) => g.projectId === "p2");
    expect(p1?.label).toBe("Alpha");
    expect(p1?.key).toBe("project:p1");
    expect(p1?.tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(p2?.tasks.map((t) => t.id)).toEqual(["b"]);
  });

  it("renders pinned projects in order even when they have no sessions", () => {
    const tasks = [task({ id: "a", project_id: "p2" })];
    const groups = groupSessions({
      ...baseArgs,
      mode: "project",
      tasks,
      pinnedProjects: [
        { id: "p1", name: "Alpha" },
        { id: "p2", name: "Beta" },
      ],
    });
    expect(groups.map((g) => g.projectId)).toEqual(["p1", "p2"]);
    expect(groups[0].tasks).toEqual([]);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(["a"]);
  });

  it("appends unpinned projects that have sessions after the pinned ones", () => {
    const tasks = [
      task({ id: "a", project_id: "p1" }),
      task({ id: "z", project_id: "p9" }),
    ];
    const groups = groupSessions({
      ...baseArgs,
      mode: "project",
      tasks,
      projectNames: { p1: "Alpha", p9: "Zeta" },
      pinnedProjects: [{ id: "p1", name: "Alpha" }],
    });
    expect(groups.map((g) => g.projectId)).toEqual(["p1", "p9"]);
    expect(groups[1].label).toBe("Zeta");
  });

  it("labels an unresolved project with the fallback", () => {
    const tasks = [task({ id: "a", project_id: "ghost" })];
    const groups = groupSessions({ ...baseArgs, mode: "project", tasks });
    expect(groups[0].label).toBe("Unknown project");
    expect(groups[0].key).toBe("project:ghost");
  });
});

describe("groupSessions — status", () => {
  it("orders buckets most-actionable first and skips empties", () => {
    const tasks = [
      task({ id: "done", status: "completed" }),
      task({ id: "wait", awaiting_input: true }),
      task({ id: "run", active_session_id: "r" }),
    ];
    const groups = groupSessions({ ...baseArgs, mode: "status", tasks });
    expect(groups.map((g) => g.key)).toEqual([
      "status:needs_input",
      "status:running",
      "status:completed",
    ]);
    expect(groups[0].label).toBe("Needs input");
    expect(groups[0].projectId).toBeNull();
  });
});

describe("groupSessions — date", () => {
  it("orders buckets newest first and skips empties", () => {
    const tasks = [
      task({ id: "old", updated_at: "2026-01-01T00:00:00.000Z" }),
      task({ id: "now", updated_at: "2026-06-27T09:00:00.000Z" }),
    ];
    const groups = groupSessions({ ...baseArgs, mode: "date", tasks });
    expect(groups.map((g) => g.key)).toEqual(["date:today", "date:older"]);
    expect(groups[0].label).toBe("Today");
    expect(groups[0].tasks.map((t) => t.id)).toEqual(["now"]);
  });
});

describe("isInboxSession", () => {
  const open = new Set(["open-project"]);
  const scratch = new Set(["general"]);

  it("keeps sessions whose project is open in the workspace", () => {
    expect(
      isInboxSession(task({ id: "a", project_id: "open-project" }), open, scratch),
    ).toBe(true);
  });

  it("keeps scratch (General) sessions even when their project is not open", () => {
    expect(
      isInboxSession(task({ id: "a", project_id: "general" }), open, scratch),
    ).toBe(true);
  });

  it("drops sessions whose project was removed from the sidebar", () => {
    expect(
      isInboxSession(task({ id: "a", project_id: "removed" }), open, scratch),
    ).toBe(false);
  });
});

// Type-only guard so the exported union stays in sync with the mode list.
const _exhaustive: SessionGroupMode[] = ["none", "project", "status", "date"];
void _exhaustive;
