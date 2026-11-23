import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
});

import {
  DEFAULT_EDGE_PREFS,
  EDGE_PREFS_STORAGE_KEY,
  clampEdgeY,
  parseEdgePrefs,
  sideForDrop,
  useEdgePrefs,
} from "./edge-prefs";

describe("edge prefs", () => {
  beforeEach(() => {
    storage.clear();
    useEdgePrefs.setState(DEFAULT_EDGE_PREFS);
  });

  it("defaults to the right edge, centred, automatic language, sounds on", () => {
    expect(parseEdgePrefs(null)).toEqual({
      side: "right",
      edgeY: 0,
      talkLanguage: null,
      playSounds: true,
    });
  });

  it("saves every change so it holds across restarts", () => {
    const { setPref } = useEdgePrefs.getState();
    setPref("side", "left");
    setPref("talkLanguage", "ja-JP");
    setPref("playSounds", false);
    expect(parseEdgePrefs(storage.get(EDGE_PREFS_STORAGE_KEY) ?? null)).toEqual(
      {
        side: "left",
        edgeY: 0,
        talkLanguage: "ja-JP",
        playSounds: false,
      },
    );
  });

  it("keeps the default for anything malformed", () => {
    expect(parseEdgePrefs('{"side":"top","edgeY":"x","playSounds":1}')).toEqual(
      DEFAULT_EDGE_PREFS,
    );
    expect(parseEdgePrefs("not json")).toEqual(DEFAULT_EDGE_PREFS);
  });

  it("keeps a dragged toolbar inside the frame", () => {
    expect(clampEdgeY(1000, 1000, 300)).toBe(342);
    expect(clampEdgeY(-1000, 1000, 300)).toBe(-342);
    expect(clampEdgeY(40.4, 1000, 300)).toBe(40);
  });

  it("drops on the nearer half of the screen", () => {
    expect(sideForDrop(100, 0, 1728)).toBe("left");
    expect(sideForDrop(1500, 0, 1728)).toBe("right");
    // A second screen to the left of the main one.
    expect(sideForDrop(-1500, -1920, 1920)).toBe("left");
    expect(sideForDrop(-200, -1920, 1920)).toBe("right");
  });
});
