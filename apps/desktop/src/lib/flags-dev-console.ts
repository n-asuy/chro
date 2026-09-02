/**
 * Devtools console access to feature flags, dev builds only.
 *
 * This module is imported solely from `main.tsx`'s dev-instrumentation block,
 * so release builds contain neither the helper nor a way to force a flag: the
 * remote kill switch stays authoritative for every shipped binary.
 *
 * Usage from the console:
 *   chroFlags.list()                 // effective values
 *   chroFlags.force("some_flag", true)
 *   chroFlags.unforce("some_flag")
 *   chroFlags.reset()                // drop every force
 *
 * Forces persist in localStorage across reloads.
 */
import { selectFlag, useFeatureFlagStore } from "./feature-flags-store";

declare global {
  interface Window {
    chroFlags?: {
      list: () => Record<string, boolean>;
      force: (key: string, value: boolean) => void;
      unforce: (key: string) => void;
      reset: () => void;
    };
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.chroFlags = {
    list: () => {
      const state = useFeatureFlagStore.getState();
      const out: Record<string, boolean> = {};
      for (const key of Object.keys(state.resolved)) {
        out[key] = selectFlag(state, key);
      }
      return out;
    },
    force: (key, value) =>
      useFeatureFlagStore.getState().setDevOverride(key, value),
    unforce: (key) => useFeatureFlagStore.getState().setDevOverride(key, null),
    reset: () => useFeatureFlagStore.getState().clearDevOverrides(),
  };
}
