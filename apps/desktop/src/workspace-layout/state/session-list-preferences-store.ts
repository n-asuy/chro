import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { useEffect } from "react";
import { create } from "zustand";

/**
 * How the left panel lays out its session list. Set from Settings and read by
 * the panel, so it lives in one store both subscribe to; persisted through the
 * shared UI-state channel like the panel's other view preferences.
 */
export const NEST_DELEGATIONS_KEY = "workspace-layout:nest-delegations:v1";

interface SessionListPreferencesStore {
  /** Delegated sessions sit under the session that delegated them. */
  nestDelegations: boolean;
  hydrated: boolean;
  /**
   * Load the persisted choice. No-op until `isUiStateReady()` returns true;
   * {@link useNestDelegations} polls until it succeeds. A change made before
   * hydration wins over the persisted value. Returns whether the store is now
   * hydrated.
   */
  hydrate: () => boolean;
  setNestDelegations: (nest: boolean) => void;
}

export const useSessionListPreferencesStore =
  create<SessionListPreferencesStore>()((set, get) => ({
    nestDelegations: false,
    hydrated: false,
    hydrate: () => {
      if (get().hydrated) return true;
      if (!isUiStateReady()) return false;
      const persisted = getUiValue<unknown>(NEST_DELEGATIONS_KEY);
      set({
        nestDelegations: typeof persisted === "boolean" ? persisted : false,
        hydrated: true,
      });
      return true;
    },
    setNestDelegations: (nest) => {
      set({ nestDelegations: nest, hydrated: true });
      setUiValue(NEST_DELEGATIONS_KEY, nest);
    },
  }));

/** Whether delegated sessions nest, hydrated from UI state on first use. */
export function useNestDelegations(): boolean {
  const hydrate = useSessionListPreferencesStore((s) => s.hydrate);
  useEffect(() => {
    if (hydrate()) return;
    const id = window.setInterval(() => {
      if (hydrate()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [hydrate]);
  return useSessionListPreferencesStore((s) => s.nestDelegations);
}
