import { create } from "zustand";
import {
  type TerminalConfig,
  DEFAULT_TERMINAL_CONFIG,
  fetchTerminalConfig,
  saveTerminalConfig,
} from "@/lib/preferences-client";

interface TerminalConfigState {
  config: TerminalConfig;
  loaded: boolean;
  loading: boolean;
}

interface TerminalConfigActions {
  load: () => Promise<void>;
  update: (partial: Partial<TerminalConfig>) => Promise<void>;
}

type TerminalConfigStore = TerminalConfigState & TerminalConfigActions;

export const useTerminalConfigStore = create<TerminalConfigStore>(
  (set, get) => ({
    config: DEFAULT_TERMINAL_CONFIG,
    loaded: false,
    loading: false,

    load: async () => {
      if (get().loaded || get().loading) return;
      set({ loading: true });
      try {
        const response = await fetchTerminalConfig();
        set({ config: response.terminal, loaded: true });
      } catch (error) {
        console.error("[terminal-config] Failed to load", error);
      } finally {
        set({ loading: false });
      }
    },

    update: async (partial) => {
      const prev = get().config;
      // Optimistic so the live terminals reflow immediately.
      set({ config: { ...prev, ...partial } });
      try {
        const response = await saveTerminalConfig(partial);
        set({ config: response.terminal });
      } catch (error) {
        console.error("[terminal-config] Failed to save", error);
        set({ config: prev });
      }
    },
  }),
);
