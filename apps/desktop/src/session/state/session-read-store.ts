import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { create } from "zustand";

/**
 * Per-machine record of when the user last opened each task, used to decide
 * whether a terminal task still carries an unread result dot in the session
 * lists. Persisted through the shared UI-state channel (local Rust server KV),
 * so it survives restarts without a database migration.
 *
 * Schema version is encoded in the key so a breaking change can coexist with
 * stale entries (older keys are simply ignored).
 */
const STORAGE_KEY = "session:read-state:v1";

/**
 * Every window of the app (session windows, the edge toolbar) keeps its own
 * copy of the marks and persists the whole map. A mark made in one window is
 * broadcast to the others, so a session read in the edge toolbar clears its
 * dot in the session window too, and no window later persists a map that is
 * missing a mark another window made.
 */
const READ_STATE_CHANNEL = "chro:session-read-state";

/** taskId -> ISO timestamp of the last view. */
export type ViewedMap = Record<string, string>;

type ViewMark = { taskId: string; viewedAt: string };

/**
 * Union of two maps, keeping the later mark per task. Marks only move
 * forward: an older mark never resurfaces a dot the user already cleared.
 * Returns `current` itself when `incoming` adds nothing, so subscribers see
 * no change.
 */
export function mergeViewedMaps(
  current: ViewedMap,
  incoming: ViewedMap,
): ViewedMap {
  let next: ViewedMap | null = null;
  for (const [taskId, viewedAt] of Object.entries(incoming)) {
    const existing = current[taskId];
    if (existing && existing >= viewedAt) continue;
    next ??= { ...current };
    next[taskId] = viewedAt;
  }
  return next ?? current;
}

function readFromStorage(): ViewedMap {
  const raw = getUiValue<ViewedMap>(STORAGE_KEY);
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

function isViewMark(value: unknown): value is ViewMark {
  if (!value || typeof value !== "object") return false;
  const { taskId, viewedAt } = value as Record<string, unknown>;
  return typeof taskId === "string" && typeof viewedAt === "string";
}

const channel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(READ_STATE_CHANNEL);

interface SessionReadStore {
  viewedAt: ViewedMap;
  hydrated: boolean;
  /**
   * Load persisted view marks. No-op until `isUiStateReady()` returns true —
   * callers (see {@link useSessionReadSync}) poll until hydration succeeds.
   * Returns whether the store is now hydrated.
   */
  hydrate: () => boolean;
  /** Record that the user has just seen a task, clearing its unread dot. */
  markViewed: (taskId: string) => void;
}

export const useSessionReadStore = create<SessionReadStore>()((set, get) => ({
  viewedAt: {},
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return true;
    if (!isUiStateReady()) return false;
    // Marks broadcast by another window before this one hydrated are kept.
    set({
      viewedAt: mergeViewedMaps(readFromStorage(), get().viewedAt),
      hydrated: true,
    });
    return true;
  },
  markViewed: (taskId) => {
    const now = new Date().toISOString();
    const next = mergeViewedMaps(get().viewedAt, { [taskId]: now });
    if (next === get().viewedAt) return;
    set({ viewedAt: next });
    setUiValue(STORAGE_KEY, next);
    channel?.postMessage({ taskId, viewedAt: now } satisfies ViewMark);
  },
}));

channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isViewMark(event.data)) return;
  const { taskId, viewedAt } = event.data;
  const state = useSessionReadStore.getState();
  const next = mergeViewedMaps(state.viewedAt, { [taskId]: viewedAt });
  if (next !== state.viewedAt) useSessionReadStore.setState({ viewedAt: next });
});
