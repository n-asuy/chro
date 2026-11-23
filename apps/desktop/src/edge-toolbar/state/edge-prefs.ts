import { create } from "zustand";

/**
 * The edge toolbar's own settings (the "…" → Settings flyout), kept in the
 * edge window's localStorage so they hold across restarts.
 */
export const EDGE_PREFS_STORAGE_KEY = "chro:edge-prefs";

export type EdgeSide = "left" | "right";

export interface EdgePrefs {
  /** Which screen edge the toolbar sits on. */
  side: EdgeSide;
  /** The toolbar's offset from the frame's vertical centre (dragged). */
  edgeY: number;
  /** The talk language; `null` is automatic (see the shell's talk_locale). */
  talkLanguage: string | null;
  playSounds: boolean;
}

export const DEFAULT_EDGE_PREFS: EdgePrefs = {
  side: "right",
  edgeY: 0,
  talkLanguage: null,
  playSounds: true,
};

/** Saved prefs over the defaults; anything malformed keeps its default. */
export function parseEdgePrefs(raw: string | null): EdgePrefs {
  if (!raw) return DEFAULT_EDGE_PREFS;
  try {
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== "object" || saved === null) return DEFAULT_EDGE_PREFS;
    const s = saved as Record<string, unknown>;
    return {
      side: s.side === "left" || s.side === "right" ? s.side : "right",
      edgeY:
        typeof s.edgeY === "number" && Number.isFinite(s.edgeY) ? s.edgeY : 0,
      talkLanguage: typeof s.talkLanguage === "string" ? s.talkLanguage : null,
      playSounds: typeof s.playSounds === "boolean" ? s.playSounds : true,
    };
  } catch {
    return DEFAULT_EDGE_PREFS;
  }
}

/** The vertical offset kept inside a frame, with an 8 pt margin. */
export function clampEdgeY(
  edgeY: number,
  frameHeight: number,
  toolbarHeight: number,
): number {
  const room = Math.max(0, frameHeight / 2 - toolbarHeight / 2 - 8);
  return Math.round(Math.min(room, Math.max(-room, edgeY)));
}

/** The side a drag ends on: the nearer half of the screen (the mock's snap). */
export function sideForDrop(
  screenX: number,
  screenLeft: number,
  screenWidth: number,
): EdgeSide {
  return screenX < screenLeft + screenWidth / 2 ? "left" : "right";
}

function readPrefs(): EdgePrefs {
  if (typeof window === "undefined") return DEFAULT_EDGE_PREFS;
  try {
    return parseEdgePrefs(window.localStorage.getItem(EDGE_PREFS_STORAGE_KEY));
  } catch {
    return DEFAULT_EDGE_PREFS;
  }
}

function writePrefs(prefs: EdgePrefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EDGE_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

interface EdgePrefsState extends EdgePrefs {
  setPref: <K extends keyof EdgePrefs>(key: K, value: EdgePrefs[K]) => void;
}

export const useEdgePrefs = create<EdgePrefsState>()((set, get) => ({
  ...readPrefs(),
  setPref: (key, value) => {
    if (get()[key] === value) return;
    set({ [key]: value } as Partial<EdgePrefs>);
    const { setPref: _, ...prefs } = get();
    writePrefs(prefs);
  },
}));

/** The prefs as last saved (other windows of the app read them this way). */
export function savedEdgePrefs(): EdgePrefs {
  return readPrefs();
}
