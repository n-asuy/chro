import { describe, expect, it } from "vitest";
import {
  type PanelPresence,
  cardEnters,
  closedPresence,
  dotsToGrow,
  hitSpan,
  keepsPeekOpen,
  keyboardSummon,
  nextNeedsYou,
  nextPresence,
  panelOnScreen,
  panelTop,
  parseCssTime,
  peekAnchor,
  toolbarSurface,
} from "./edge-motion";

const unread = { kind: "unread" } as const;
const session = (taskId: string) => ({ kind: "session", taskId }) as const;

describe("toolbarSurface", () => {
  it("is expanded while out or while a panel is open, otherwise the tab", () => {
    expect(toolbarSurface(false, null)).toBe("collapsed");
    expect(toolbarSurface(true, null)).toBe("expanded");
    expect(toolbarSurface(false, unread)).toBe("expanded");
  });
});

describe("panel presence", () => {
  it("shows an opened panel at once", () => {
    expect(nextPresence(closedPresence, unread)).toEqual({
      shown: unread,
      on: true,
    });
  });

  it("keeps a closed panel mounted, off, so its exit transition can play", () => {
    const open: PanelPresence = { shown: session("a"), on: true };
    expect(nextPresence(open, null)).toEqual({
      shown: session("a"),
      on: false,
    });
  });

  it("swaps the content of an open panel in place, with no exit", () => {
    const open: PanelPresence = { shown: session("a"), on: true };
    expect(nextPresence(open, unread)).toEqual({ shown: unread, on: true });
  });

  it("returns the same object when nothing changed", () => {
    const open: PanelPresence = { shown: unread, on: true };
    expect(nextPresence(open, { kind: "unread" })).toBe(open);
    expect(nextPresence(closedPresence, null)).toBe(closedPresence);
  });
});

describe("cardEnters", () => {
  it("plays when the pager moves to another item, not when it first shows one", () => {
    expect(cardEnters(null, "a")).toBe(false);
    expect(cardEnters("a", "a")).toBe(false);
    expect(cardEnters("a", "b")).toBe(true);
    expect(cardEnters("a", null)).toBe(false);
  });
});

describe("dotsToGrow", () => {
  it("grows only dots appended after the first render", () => {
    expect(dotsToGrow(null, ["a", "b"])).toEqual([]);
    expect(dotsToGrow(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
    expect(dotsToGrow(["a", "b"], ["a"])).toEqual([]);
  });

  it("does not grow a dot that took another's slot, so nothing moves", () => {
    expect(dotsToGrow(["a", "b", "c"], ["a", "new", "c"])).toEqual([]);
  });
});

describe("panelTop", () => {
  it("lines the panel up with the top of the toolbar", () => {
    expect(panelTop({ anchor: 300, height: 400, frameHeight: 1000 })).toBe(300);
  });

  it("keeps the panel 8 pt inside the frame", () => {
    expect(panelTop({ anchor: 2, height: 400, frameHeight: 1000 })).toBe(8);
    expect(panelTop({ anchor: 800, height: 400, frameHeight: 1000 })).toBe(592);
  });
});

describe("parseCssTime", () => {
  it("reads milliseconds and seconds as the stylesheet writes them", () => {
    expect(parseCssTime(" 320ms")).toBe(320);
    expect(parseCssTime("1.3s")).toBe(1300);
  });

  it("falls back when the value is missing or unreadable", () => {
    expect(parseCssTime("", 99)).toBe(99);
    expect(parseCssTime("fast", 99)).toBe(99);
  });
});

describe("panelOnScreen", () => {
  it("starts the open transition only once the content has laid out its data", () => {
    expect(
      panelOnScreen({
        open: true,
        mounted: true,
        contentReady: false,
        waitedOut: false,
      }),
    ).toBe(false);
    expect(
      panelOnScreen({
        open: true,
        mounted: true,
        contentReady: true,
        waitedOut: false,
      }),
    ).toBe(true);
  });

  it("does not wait on slow content forever", () => {
    expect(
      panelOnScreen({
        open: true,
        mounted: true,
        contentReady: false,
        waitedOut: true,
      }),
    ).toBe(true);
  });

  it("is off while closed or before the frame's off style is committed", () => {
    expect(
      panelOnScreen({
        open: false,
        mounted: true,
        contentReady: true,
        waitedOut: true,
      }),
    ).toBe(false);
    expect(
      panelOnScreen({
        open: true,
        mounted: false,
        contentReady: true,
        waitedOut: true,
      }),
    ).toBe(false);
  });
});

describe("keyboardSummon", () => {
  it("opens Unread when something needs the user, the session list otherwise", () => {
    expect(keyboardSummon(null, true)).toBe("unread");
    expect(keyboardSummon(null, false)).toBe("list");
  });

  it("closes what the gesture opened when pressed again", () => {
    expect(keyboardSummon({ kind: "unread" }, true)).toBe("close");
    expect(keyboardSummon({ kind: "list" }, false)).toBe("close");
  });

  it("goes to Unread from any other panel when something needs the user", () => {
    expect(keyboardSummon({ kind: "session", taskId: "a" }, true)).toBe(
      "unread",
    );
    expect(keyboardSummon({ kind: "list" }, true)).toBe("unread");
    expect(keyboardSummon({ kind: "usage" }, false)).toBe("list");
  });
});

describe("nextNeedsYou", () => {
  it("opens the first session that needs the person", () => {
    expect(nextNeedsYou(["a", "b", "c"], null)).toBe("a");
  });

  it("moves to the next one on each press, around to the first", () => {
    expect(nextNeedsYou(["a", "b", "c"], "a")).toBe("b");
    expect(nextNeedsYou(["a", "b", "c"], "c")).toBe("a");
  });

  it("starts over when the last opened one no longer needs the person", () => {
    // Opening it marked it read, so it left the list.
    expect(nextNeedsYou(["b", "c"], "a")).toBe("b");
  });

  it("does nothing when nothing needs the person", () => {
    expect(nextNeedsYou([], null)).toBeNull();
    expect(nextNeedsYou([], "a")).toBeNull();
  });
});

describe("hitSpan", () => {
  const box = { left: 718.4, right: 752.6 };

  it("is the surface's own box when it does not reach the edge", () => {
    expect(hitSpan(box, 760, false, "right")).toEqual({
      left: 718,
      right: 753,
    });
    expect(hitSpan(box, 760, false, "left")).toEqual({ left: 718, right: 753 });
  });

  it("reaches the right screen edge when docked right", () => {
    expect(hitSpan(box, 760, true, "right")).toEqual({ left: 718, right: 760 });
  });

  it("reaches the left screen edge when docked left (the mirror)", () => {
    const mirrored = { left: 7.4, right: 41.6 };
    expect(hitSpan(mirrored, 760, true, "left")).toEqual({
      left: 0,
      right: 42,
    });
  });
});

describe("keepsPeekOpen", () => {
  it("keeps a tile's preview open over a tile, the card and its bridge, and the capsule between tiles", () => {
    for (const id of ["tile:t1", "tile:t2", "peek", "capsule"]) {
      expect(keepsPeekOpen(id)).toBe(true);
    }
  });

  it("lets it close anywhere else", () => {
    for (const id of [null, "tab", "more", "mic", "row:t1", "settings:look"]) {
      expect(keepsPeekOpen(id)).toBe(false);
    }
  });
});

describe("peekAnchor", () => {
  it("puts the preview's header level with the tile", () => {
    // A 32 pt tile at 300: its centre (316) meets the header's centre.
    expect(peekAnchor({ tileTop: 300, tileHeight: 32 })).toBe(316 - 22);
  });

  it("is kept inside the frame by the panel clamp", () => {
    const anchor = peekAnchor({ tileTop: 2, tileHeight: 32 });
    expect(panelTop({ anchor, height: 300, frameHeight: 900 })).toBe(8);
    const low = peekAnchor({ tileTop: 880, tileHeight: 32 });
    expect(panelTop({ anchor: low, height: 300, frameHeight: 900 })).toBe(592);
  });
});
