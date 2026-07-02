import { create } from "zustand";
import { type FlagKey, fetchFlagRegistry } from "./flags-client";

interface FeatureFlagState {
  resolved: Record<string, boolean>;
  loading: boolean;
  load: () => Promise<void>;
}

export const useFeatureFlagStore = create<FeatureFlagState>()((set, get) => ({
  resolved: {},
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const registry = await fetchFlagRegistry();
      const resolved: Record<string, boolean> = {};
      for (const flag of registry) {
        resolved[flag.key] = flag.resolved_value;
      }
      set({ resolved, loading: false });
    } catch {
      // Leave flags at their defaults (false) if the registry can't load.
      set({ loading: false });
    }
  },
}));

/**
 * Effective value of a feature flag: the backend-resolved value, then `false`.
 * Feature code should gate on this hook.
 */
export function useFlag(key: FlagKey): boolean {
  return useFeatureFlagStore((state) => state.resolved[key] ?? false);
}
