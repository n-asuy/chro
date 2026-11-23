import {
  getUiDatabase,
  getUiValue,
  isUiStateReady,
  setUiValue,
} from "@/lib/ui-state-client";
import { create } from "zustand";
import type { CapsuleDot } from "../domain/capsule-dots";
import { type CapsuleEdge, nextEdge, parseEdge } from "../domain/capsule-slots";

/** Where one database's edge is stored. */
export const capsuleSlotsKey = (database: string) =>
  `edge-toolbar:capsule-slots:v1:${database}`;

interface CapsuleSlotsStore {
  /** Null until decided for the first time. */
  edge: CapsuleEdge | null;
  hydrated: boolean;
  /**
   * Load the stored edge. No-op until UI state is loaded. Returns whether
   * the store is now hydrated.
   */
  hydrate: () => boolean;
  /** Move to the next state (see `nextEdge`) and store it if it changed. */
  advance: (sessions: readonly CapsuleDot[], frozen: boolean) => void;
}

/** Which sessions are on the edge and where, kept across restarts. */
export const useCapsuleSlotsStore = create<CapsuleSlotsStore>()((set, get) => ({
  edge: null,
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return true;
    if (!isUiStateReady()) return false;
    const database = getUiDatabase();
    set({
      edge: database
        ? parseEdge(getUiValue<unknown>(capsuleSlotsKey(database)))
        : null,
      hydrated: true,
    });
    return true;
  },
  advance: (sessions, frozen) => {
    const { edge, hydrated } = get();
    if (!hydrated) return;
    const next = nextEdge(edge, sessions, frozen);
    if (next === edge) return;
    set({ edge: next });
    const database = getUiDatabase();
    if (database) setUiValue(capsuleSlotsKey(database), next);
  },
}));
