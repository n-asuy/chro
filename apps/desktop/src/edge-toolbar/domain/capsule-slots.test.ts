import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import type { CapsuleDot } from "./capsule-dots";
import {
  CAPSULE_SLOTS,
  type CapsuleEdge,
  capsuleTiles,
  nextEdge,
  parseEdge,
} from "./capsule-slots";

/** `minute` minutes past 10:00, as the server writes it. */
const at = (minute: number) =>
  new Date(Date.UTC(2026, 10, 23, 10, minute)).toISOString();

type Kind = "waiting" | "failed" | "running" | "done" | "read";

/** A session last updated at `minute`, last viewed at `viewed` (null: never). */
function dot(
  id: string,
  kind: Kind,
  minute = 0,
  viewed: number | null = null,
): CapsuleDot {
  const task: StoredTask = {
    id,
    project_id: "p",
    title: id,
    status: kind === "failed" ? "failed" : "completed",
    awaiting_input: kind === "waiting",
    active_session_id:
      kind === "running" || kind === "waiting" ? `s-${id}` : null,
    created_at: at(0),
    updated_at: at(minute),
    sort_order: 0,
  };
  const status = {
    waiting: "waiting",
    failed: "waiting",
    running: "running",
    done: "done",
    read: "idle",
  } as const;
  return {
    task,
    status: status[kind],
    viewedAt: viewed === null ? null : at(viewed),
  };
}

/** Eight read sessions r0..r7, viewed in the order of `viewed`. */
const eightRead = (viewed = [10, 11, 12, 13, 14, 15, 16, 17]) =>
  viewed.map((minute, i) => dot(`r${i}`, "read", 1, minute));
const R = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];

/** The edge holding `slots`, with nothing refused a slot so far. */
const edge = (slots: readonly string[]): CapsuleEdge => ({ slots, line: {} });

/** The slots after one change. */
const step = (
  slots: readonly string[] | null,
  sessions: readonly CapsuleDot[],
  frozen = false,
) => nextEdge(slots && edge(slots), sessions, frozen).slots;

/** The slots after each change in turn. */
function steps(
  slots: readonly string[],
  ...changes: (readonly CapsuleDot[])[]
): (readonly string[])[] {
  let state = edge(slots);
  return changes.map((sessions) => {
    state = nextEdge(state, sessions, false);
    return state.slots;
  });
}

describe("joining", () => {
  it("a session joins when it starts running, waits on the user, or finishes unread", () => {
    for (const kind of ["running", "waiting", "failed", "done"] as const) {
      expect(step(["a"], [dot("a", "read"), dot("b", kind)])).toEqual([
        "a",
        "b",
      ]);
    }
  });

  it("a read session off the edge does not join, even with free slots", () => {
    expect(step(["a"], [dot("a", "read"), dot("b", "read", 50)])).toEqual([
      "a",
    ]);
  });

  it("a newcomer appends at the end, several in the order things happened to them", () => {
    expect(
      step(
        ["a"],
        [
          dot("late", "waiting", 9),
          dot("early", "running", 3),
          dot("a", "read", 20),
        ],
      ),
    ).toEqual(["a", "early", "late"]);
  });
});

describe("staying", () => {
  it("reading a finished session keeps its slot and every other tile's", () => {
    const before = ["a", "b", "c"];
    const sessions = (b: Kind) => [
      dot("a", "read", 1),
      dot("b", b, 5),
      dot("c", "running", 9),
    ];
    expect(step(before, sessions("done"))).toEqual(before);
    expect(step(before, sessions("read"))).toEqual(before);
  });

  it("no state change or activity moves a tile", () => {
    const slots = ["a", "b", "c"];
    for (const kind of [
      "waiting",
      "failed",
      "running",
      "done",
      "read",
    ] as const) {
      expect(
        step(slots, [dot("a", "read"), dot("b", "read"), dot("c", kind, 99)]),
      ).toEqual(slots);
    }
  });

  it("is the same order however the sessions arrive", () => {
    const slots = ["a", "b", "c"];
    const sessions = [dot("c", "done"), dot("a", "running"), dot("b", "read")];
    expect(step(slots, sessions)).toEqual(slots);
    expect(step(slots, [...sessions].reverse())).toEqual(slots);
  });
});

describe("leaving", () => {
  it("an archived or deleted session leaves and the rest close up", () => {
    expect(
      step(["a", "b", "c"], [dot("a", "read"), dot("c", "running")]),
    ).toEqual(["a", "c"]);
  });

  it("its slot goes to nobody who only was read", () => {
    const rest = eightRead().slice(1);
    expect(step(R, [...rest, dot("other", "read", 99)])).toEqual(R.slice(1));
  });

  it("a session waiting in +N joins when a slot frees", () => {
    const busy = R.map((id, i) => dot(id, "running", i));
    const ninth = dot("ninth", "done", 20);
    expect(steps(R, [...busy, ninth], [...busy.slice(1), ninth])).toEqual([
      R,
      [...R.slice(1), "ninth"],
    ]);
  });

  it("the session that waits on the user is first in line for a freed slot", () => {
    const waiting = R.map((id, i) => dot(id, "waiting", i));
    const line = [dot("ran", "running", 1), dot("asks", "waiting", 30)];
    expect(
      steps(R, [...waiting, ...line], [...waiting.slice(1), ...line]),
    ).toEqual([R, [...R.slice(1), "asks"]]);
  });
});

describe("replacing when the slots are full", () => {
  it("the ninth session takes the slot of the read one viewed longest ago, in place", () => {
    const sessions = eightRead([15, 14, 3, 13, 16, 12, 11, 17]);
    expect(step(R, [...sessions, dot("new", "running", 30)])).toEqual([
      "r0",
      "r1",
      "new",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
    ]);
  });

  it("goes by when a session was viewed, not by its last activity", () => {
    const sessions = eightRead();
    sessions[0] = dot("r0", "read", 59, 2);
    sessions[7] = dot("r7", "read", 0, 40);
    expect(step(R, [...sessions, dot("new", "done", 30)])[0]).toBe("new");
  });

  it("a read session that was never viewed counts as viewed longest ago", () => {
    const sessions = eightRead();
    sessions[5] = dot("r5", "read", 59, null);
    expect(step(R, [...sessions, dot("new", "running", 30)])[5]).toBe("new");
  });

  it("two newcomers replace two read ones, each once", () => {
    const sessions = [
      ...eightRead(),
      dot("n1", "running", 30),
      dot("n2", "done", 31),
    ];
    const settled = ["n1", "n2", ...R.slice(2)];
    // The replaced ones are read, so they do not come back.
    expect(steps(R, sessions, sessions)).toEqual([settled, settled]);
  });

  it("running, waiting and unread sessions are never replaced by a running or finished one", () => {
    const slots = [
      dot("r0", "running"),
      dot("r1", "waiting"),
      dot("r2", "failed"),
      dot("r3", "done"),
      dot("r4", "running"),
      dot("r5", "done"),
      dot("r6", "waiting"),
      dot("r7", "done"),
    ];
    for (const kind of ["running", "done", "failed"] as const) {
      expect(step(R, [...slots, dot("new", kind, 30)])).toEqual(R);
    }
  });

  it("with nothing read, a waiting newcomer takes the oldest unread finished one's slot", () => {
    const slots = R.map((id, i) => dot(id, "running", i));
    slots[3] = dot("r3", "done", 20);
    slots[6] = dot("r6", "failed", 9);
    const all = [...slots, dot("asks", "waiting", 30)];
    const settled = [...R.slice(0, 6), "asks", "r7"];
    // The one that gave up its slot waits in +N; it does not take one back.
    expect(steps(R, all, all)).toEqual([settled, settled]);
  });

  it("with nothing read or finished, it takes the oldest running one's slot", () => {
    const slots = R.map((id, i) => dot(id, "running", 20 - i));
    slots[0] = dot("r0", "waiting", 0);
    expect(step(R, [...slots, dot("asks", "waiting", 30)])).toEqual([
      ...R.slice(0, 7),
      "asks",
    ]);
  });

  it("waiting never replaces waiting", () => {
    const slots = R.map((id, i) => dot(id, "waiting", i));
    expect(step(R, [...slots, dot("asks", "waiting", 30)])).toEqual(R);
  });

  it("a waiting newcomer prefers a read slot over anything unread", () => {
    const slots = R.map((id, i) => dot(id, "done", i));
    slots[7] = dot("r7", "read", 50, 55);
    expect(step(R, [...slots, dot("asks", "waiting", 30)])[7]).toBe("asks");
  });

  it("a waiting newcomer gets the read slot ahead of a finished one that came earlier", () => {
    const slots = R.map((id, i) => dot(id, "waiting", i));
    slots[2] = dot("r2", "read", 1, 2);
    const next = step(R, [
      ...slots,
      dot("fin", "done", 10),
      dot("asks", "waiting", 30),
    ]);
    expect(next[2]).toBe("asks");
    expect(next).not.toContain("fin");
  });
});

describe("waiting in +N", () => {
  const full = R.map((id, i) => dot(id, "done", i));
  const queued = [dot("q1", "done", 20), dot("q2", "running", 21)];
  const readFirst = [dot("r0", "read", 0, 30), ...full.slice(1)];

  it("reading a tile does not hand its slot to a session already in +N", () => {
    expect(steps(R, [...full, ...queued], [...readFirst, ...queued])).toEqual([
      R,
      R,
    ]);
  });

  it("the next session to join takes the slot that was read", () => {
    const late = dot("late", "running", 40);
    const [, , last] = steps(
      R,
      [...full, ...queued],
      [...readFirst, ...queued],
      [...readFirst, ...queued, late],
    );
    expect(last).toEqual(["late", ...R.slice(1)]);
  });

  it("a session in +N joins anew when its state changes", () => {
    const asked = dot("q2", "waiting", 40);
    const [, , last] = steps(
      R,
      [...full, ...queued],
      [...readFirst, ...queued],
      [...readFirst, queued[0], asked],
    );
    expect(last).toEqual(["q2", ...R.slice(1)]);
  });

  it("a session read in +N and finished again later joins anew", () => {
    const [, , , last] = steps(
      R,
      [...full, ...queued],
      [...readFirst, ...queued],
      [...readFirst, dot("q1", "read", 20, 35), queued[1]],
      [...readFirst, dot("q1", "done", 50), queued[1]],
    );
    expect(last).toEqual(["q1", ...R.slice(1)]);
  });

  it("activity alone is not a new join", () => {
    const touched = [dot("q1", "done", 55), dot("q2", "running", 56)];
    expect(steps(R, [...full, ...queued], [...readFirst, ...touched])).toEqual([
      R,
      R,
    ]);
  });
});

describe("while frozen (the pointer on the toolbar, or a panel open)", () => {
  it("nothing is appended or replaced, then everything applies once", () => {
    const sessions = [...eightRead(), dot("new", "running", 30)];
    const before = edge(R);
    expect(nextEdge(before, sessions, true)).toBe(before);
    const applied = nextEdge(before, sessions, false);
    expect(applied.slots).toEqual(["new", ...R.slice(1)]);
    expect(nextEdge(applied, sessions, true)).toBe(applied);
    expect(nextEdge(applied, sessions, false)).toBe(applied);
    expect(step(["a"], [dot("a", "read"), dot("b", "done")], true)).toEqual([
      "a",
    ]);
  });

  it("an archive applies at once, and the freed slot is filled only later", () => {
    const busy = R.map((id, i) => dot(id, "running", i)).slice(1);
    const sessions = [...busy, dot("ninth", "done", 20)];
    const closedUp = nextEdge(edge(R), sessions, true);
    expect(closedUp.slots).toEqual(R.slice(1));
    expect(nextEdge(closedUp, sessions, false).slots).toEqual([
      ...R.slice(1),
      "ninth",
    ]);
  });

  it("a session that joined while frozen still replaces a tile read meanwhile", () => {
    const full = R.map((id, i) => dot(id, "done", i));
    const late = dot("late", "running", 40);
    const frozen = nextEdge(edge(R), [...full, late], true);
    const read = [dot("r0", "read", 0, 41), ...full.slice(1), late];
    expect(nextEdge(frozen, read, false).slots[0]).toBe("late");
  });
});

describe("the first run and restarts", () => {
  it("with nothing stored, fills with the not-read ones first, then the read ones updated last", () => {
    const sessions = [
      dot("old-read", "read", 1),
      dot("new-read", "read", 50),
      dot("done", "done", 5),
      dot("run", "running", 2),
      dot("ask", "waiting", 1),
    ];
    expect(step(null, sessions)).toEqual([
      "ask",
      "run",
      "done",
      "new-read",
      "old-read",
    ]);
  });

  it("fills up to the eight slots", () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      dot(`s${i}`, "read", i),
    );
    expect(CAPSULE_SLOTS).toBe(8);
    expect(step(null, sessions)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4].map((i) => `s${i}`),
    );
  });

  it("fills the first run even while frozen (nothing is shown to move)", () => {
    expect(step(null, [dot("a", "read")], true)).toEqual(["a"]);
  });

  const stored = (edge: CapsuleEdge) =>
    parseEdge(JSON.parse(JSON.stringify(edge)));

  it("restores the stored order after a restart, whatever the sessions did meanwhile", () => {
    const sessions = [
      dot("a", "waiting", 90),
      dot("b", "read", 80),
      dot("c", "read", 1),
      dot("d", "read", 99),
    ];
    const restored = stored(edge(["c", "a", "b"]));
    expect(nextEdge(restored, sessions, false).slots).toEqual(["c", "a", "b"]);
  });

  it("a restart hands no read tile's slot to the sessions that were in +N", () => {
    const sessions = [...eightRead(), dot("q", "done", 20)];
    // First run: the unread one is in, seven read ones beside it.
    const first = nextEdge(null, sessions, false);
    const nine = [...sessions, dot("q2", "running", 0)];
    const full = R.map((id, i) => dot(id, "done", i));
    const refused = nextEdge(edge(R), [...full, dot("q", "done", 20)], false);
    const afterRead = [...eightRead(), dot("q", "done", 20)];
    expect(nextEdge(stored(refused), afterRead, false).slots).toEqual(R);
    expect(nextEdge(stored(first), sessions, false).slots).toEqual(first.slots);
    expect(nextEdge(stored(first), nine, false).slots).toContain("q2");
  });

  it("the first run puts the not-read sessions that do not fit in +N", () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      dot(`s${i}`, "done", i),
    );
    const first = nextEdge(null, sessions, false);
    const read = sessions.map((d) =>
      d.task.id === "s9" ? dot("s9", "read", 9, 30) : d,
    );
    expect(nextEdge(first, read, false).slots).toEqual(first.slots);
  });

  it("an emptied edge is not a first run", () => {
    expect(step([], [dot("a", "read", 50)])).toEqual([]);
  });

  it("reads only what it stored", () => {
    const line = { q: "done", w: "waiting", r: "running" } as const;
    expect(parseEdge({ slots: ["a", "b", "a"], line })).toEqual({
      slots: ["a", "b"],
      line,
    });
    expect(parseEdge({ slots: ["a"], line: { q: "other", n: 1 } })).toEqual(
      edge(["a"]),
    );
    expect(parseEdge({ slots: ["a"] })).toEqual(edge(["a"]));
    for (const other of [null, undefined, "a", ["a"], { slots: [1, 2] }]) {
      expect(parseEdge(other)).toBeNull();
    }
    const long = Array.from({ length: 11 }, (_, i) => `s${i}`);
    expect(parseEdge({ slots: long, line: {} })?.slots).toEqual(
      long.slice(0, 8),
    );
  });
});

describe("capsuleTiles", () => {
  it("shows the slots' sessions in slot order, with their state", () => {
    const { shown } = capsuleTiles(
      ["b", "a"],
      [dot("a", "read"), dot("b", "done")],
    );
    expect(shown.map((d) => [d.task.id, d.status])).toEqual([
      ["b", "done"],
      ["a", "idle"],
    ]);
  });

  it("counts the sessions off the edge", () => {
    const sessions = [dot("a", "read"), dot("b", "read"), dot("c", "running")];
    expect(capsuleTiles(["a"], sessions).hidden).toBe(2);
    expect(capsuleTiles(["a", "b", "c"], sessions).hidden).toBe(0);
  });

  it("reading a session changes neither the members nor their number", () => {
    const tiles = (b: Kind) =>
      capsuleTiles(["a", "b"], [dot("a", "running"), dot("b", b)]);
    const ids = (b: Kind) => tiles(b).shown.map((d) => d.task.id);
    expect(ids("read")).toEqual(ids("done"));
  });

  it("ticks the tab only for a session off the edge that is not read", () => {
    const off = (kind: Kind) =>
      capsuleTiles(["a"], [dot("a", "read"), dot("b", kind)]).overflow;
    expect(off("read")).toBe(false);
    for (const kind of ["running", "waiting", "failed", "done"] as const) {
      expect(off(kind)).toBe(true);
    }
  });
});
