import {
  type AppearanceConfig,
  DEFAULT_APPEARANCE_CONFIG,
  fetchAppearanceConfig,
  saveAppearanceConfig,
} from "@/lib/preferences-client";
import { create } from "zustand";

interface AppearanceConfigState {
  config: AppearanceConfig;
  loaded: boolean;
  loading: boolean;
}

interface AppearanceConfigActions {
  load: () => Promise<void>;
  update: (partial: Partial<AppearanceConfig>) => Promise<void>;
}

type AppearanceConfigStore = AppearanceConfigState & AppearanceConfigActions;

function isSameValue(
  config: AppearanceConfig,
  partial: Partial<AppearanceConfig>,
): boolean {
  return (Object.keys(partial) as Array<keyof AppearanceConfig>).every(
    (key) => config[key] === partial[key],
  );
}

// Monotonic token so a slow/out-of-order save echo can't resurrect a stale
// value over a newer edit. The store is a singleton, so module scope is the
// single source for the latest-issued save (guards the documented settle-loop
// and pending-settle bug classes).
let latestSaveToken = 0;

export const useAppearanceConfigStore = create<AppearanceConfigStore>(
  (set, get) => ({
    config: DEFAULT_APPEARANCE_CONFIG,
    loaded: false,
    loading: false,

    load: async () => {
      if (get().loaded || get().loading) return;
      set({ loading: true });
      try {
        const response = await fetchAppearanceConfig();
        set({ config: response.appearance, loaded: true });
      } catch (error) {
        console.error("[appearance-config] Failed to load", error);
      } finally {
        set({ loading: false });
      }
    },

    update: async (partial) => {
      const prev = get().config;
      // Idempotent: a no-op update must not mint a fresh config object or fire a
      // save. Re-rendering effects keyed on the config would otherwise loop.
      if (isSameValue(prev, partial)) return;

      // Optimistic update so the change applies instantly.
      set({ config: { ...prev, ...partial } });
      const token = ++latestSaveToken;
      try {
        const response = await saveAppearanceConfig(partial);
        // A newer update superseded this one — drop the stale echo.
        if (token !== latestSaveToken) return;
        set({ config: response.appearance });
      } catch (error) {
        console.error("[appearance-config] Failed to save", error);
        // Only roll back if no newer update is in flight; otherwise the newer
        // edit owns the current state.
        if (token === latestSaveToken) {
          set({ config: prev });
        }
      }
    },
  }),
);
