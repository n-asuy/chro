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

/** taskId -> ISO timestamp of the last view. */
type ViewedMap = Record<string, string>;

function readFromStorage(): ViewedMap {
  const raw = getUiValue<ViewedMap>(STORAGE_KEY);
  if (!raw || typeof raw !== "object") return {};
  return raw;
}

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
    set({ viewedAt: readFromStorage(), hydrated: true });
    return true;
  },
  markViewed: (taskId) => {
    const current = get().viewedAt[taskId];
    const now = new Date().toISOString();
    // Monotonic guard: never move a view mark backwards if clocks or callers
    // disagree, which would otherwise resurface a dot the user already cleared.
    if (current && current >= now) return;
    const next = { ...get().viewedAt, [taskId]: now };
    set({ viewedAt: next });
    setUiValue(STORAGE_KEY, next);
  },
}));
