import { create } from "zustand";
import {
  type EditorConfig,
  DEFAULT_EDITOR_CONFIG,
  fetchEditorConfig,
  saveEditorConfig,
} from "@/lib/preferences-client";

interface EditorConfigState {
  config: EditorConfig;
  loaded: boolean;
  loading: boolean;
}

interface EditorConfigActions {
  load: () => Promise<void>;
  update: (partial: Partial<EditorConfig>) => Promise<void>;
}

type EditorConfigStore = EditorConfigState & EditorConfigActions;

export const useEditorConfigStore = create<EditorConfigStore>((set, get) => ({
  config: DEFAULT_EDITOR_CONFIG,
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loaded || get().loading) return;
    set({ loading: true });
    try {
      const response = await fetchEditorConfig();
      set({ config: response.editor, loaded: true });
    } catch (error) {
      console.error("[editor-config] Failed to load", error);
    } finally {
      set({ loading: false });
    }
  },

  update: async (partial) => {
    const prev = get().config;
    // Optimistic update
    set({ config: { ...prev, ...partial } });
    try {
      const response = await saveEditorConfig(partial);
      set({ config: response.editor });
    } catch (error) {
      console.error("[editor-config] Failed to save", error);
      // Rollback
      set({ config: prev });
    }
  },
}));
