import { describe, expect, it } from "vitest";
import {
  type PanelPresence,
  badgeShown,
  cardEnters,
  closedPresence,
  dotsToGrow,
  keyboardSummon,
  nextPresence,
  panelOnScreen,
  panelTop,
  parseCssTime,
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
  it("grows only dots that join after the first render", () => {
    expect(dotsToGrow(null, ["a", "b"])).toEqual([]);
    expect(dotsToGrow(new Set(["a", "b"]), ["c", "a", "b"])).toEqual(["c"]);
    expect(dotsToGrow(new Set(["a", "b"]), ["a"])).toEqual([]);
  });
});

describe("badgeShown", () => {
  it("pops in only on the expanded toolbar, and only when something needs the user", () => {
    expect(badgeShown("expanded", true)).toBe(true);
    expect(badgeShown("collapsed", true)).toBe(false);
    expect(badgeShown("expanded", false)).toBe(false);
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
