import { create } from "zustand";
import {
  type AppearanceConfig,
  DEFAULT_APPEARANCE_CONFIG,
  fetchAppearanceConfig,
  saveAppearanceConfig,
} from "@/lib/preferences-client";

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
      // Optimistic update so the theme switches instantly.
      set({ config: { ...prev, ...partial } });
      try {
        const response = await saveAppearanceConfig(partial);
        set({ config: response.appearance });
      } catch (error) {
        console.error("[appearance-config] Failed to save", error);
        // Rollback
        set({ config: prev });
      }
    },
  }),
);
