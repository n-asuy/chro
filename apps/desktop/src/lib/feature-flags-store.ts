import { create } from "zustand";
import { type FlagKey, type FlagView, fetchFlagRegistry } from "./flags-client";

// Local developer overrides let you flip a flag on your own machine without
// touching PostHog rollout. They are persisted per-installation and take
// precedence over the backend-resolved value.
const OVERRIDES_KEY = "chro.feature-flag-overrides";

function loadOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // Corrupt value: fall back to no overrides.
  }
  return {};
}

function saveOverrides(overrides: Record<string, boolean>): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Storage unavailable (private mode etc.): overrides stay in-memory only.
  }
}

interface FeatureFlagState {
  registry: FlagView[];
  resolved: Record<string, boolean>;
  overrides: Record<string, boolean>;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  setOverride: (key: string, value: boolean) => void;
  clearOverride: (key: string) => void;
  clearAllOverrides: () => void;
}

export const useFeatureFlagStore = create<FeatureFlagState>()((set, get) => ({
  registry: [],
  resolved: {},
  overrides: loadOverrides(),
  loading: false,
  loaded: false,
  error: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const registry = await fetchFlagRegistry();
      const resolved: Record<string, boolean> = {};
      for (const flag of registry) {
        resolved[flag.key] = flag.resolved_value;
      }
      set({ registry, resolved, loading: false, loaded: true });
    } catch (error) {
      set({
        loading: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to load feature flags",
      });
    }
  },

  setOverride: (key, value) => {
    const overrides = { ...get().overrides, [key]: value };
    saveOverrides(overrides);
    set({ overrides });
  },

  clearOverride: (key) => {
    const overrides = { ...get().overrides };
    delete overrides[key];
    saveOverrides(overrides);
    set({ overrides });
  },

  clearAllOverrides: () => {
    saveOverrides({});
    set({ overrides: {} });
  },
}));

function effectiveValue(state: FeatureFlagState, key: string): boolean {
  if (key in state.overrides) return state.overrides[key];
  return state.resolved[key] ?? false;
}

/**
 * Effective value of a feature flag: a local developer override wins, then the
 * backend-resolved value, then `false`. Feature code should gate on this hook.
 */
export function useFlag(key: FlagKey): boolean {
  return useFeatureFlagStore((state) => effectiveValue(state, key));
}

export function isOverridden(
  overrides: Record<string, boolean>,
  key: string,
): boolean {
  return key in overrides;
}
