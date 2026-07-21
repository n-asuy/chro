import { create } from "zustand";
import { type FlagView, fetchFlagRegistry } from "./flags-client";
import { FLAG_DEFAULTS, type FlagKey } from "./flags.generated";

/**
 * Local, per-machine developer overrides. These never reach the backend or
 * PostHog: they exist so a developer can exercise both sides of a flag without
 * a rollout. Stored in `localStorage` rather than the backend ui-state so they
 * are readable synchronously on the first render, like the compiled-in
 * defaults they sit on top of.
 */
export const FLAG_OVERRIDES_STORAGE_KEY = "chro:feature-flag-overrides";

export function readPersistedOverrides(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(FLAG_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const overrides: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") overrides[key] = value;
    }
    return overrides;
  } catch {
    // Unparsable, or localStorage unavailable in a restricted webview.
    return {};
  }
}

function persistOverrides(overrides: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify(overrides),
    );
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

interface FeatureFlagState {
  /** Registry metadata, empty until the backend responds. */
  registry: FlagView[];
  /** Compiled-in defaults, overlaid with the backend's resolved values. */
  resolved: Record<string, boolean>;
  overrides: Record<string, boolean>;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  /**
   * Force a flag on or off locally; `null` returns it to the resolved value.
   * Keyed by `string` rather than `FlagKey`: the caller is the developer panel
   * walking the registry the server sent, so the keys are runtime data. Gating
   * a feature is the hand-authored case, and `useFlag` narrows that one.
   */
  setOverride: (key: string, value: boolean | null) => void;
  clearOverrides: () => void;
}

export const useFeatureFlagStore = create<FeatureFlagState>()((set, get) => ({
  registry: [],
  resolved: { ...FLAG_DEFAULTS },
  overrides: readPersistedOverrides(),
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const registry = await fetchFlagRegistry();
      const resolved: Record<string, boolean> = { ...FLAG_DEFAULTS };
      for (const flag of registry) {
        resolved[flag.key] = flag.resolved_value;
      }
      set({ registry, resolved, loaded: true, loading: false });
    } catch {
      // Keep the compiled-in defaults: the backend resolves to those on any
      // failure, so an unreachable registry must land on the same value.
      set({ loading: false });
    }
  },

  setOverride: (key, value) => {
    const overrides = { ...get().overrides };
    if (value === null) {
      delete overrides[key];
    } else {
      overrides[key] = value;
    }
    persistOverrides(overrides);
    set({ overrides });
  },

  clearOverrides: () => {
    persistOverrides({});
    set({ overrides: {} });
  },
}));

/**
 * Precedence: local developer override, then the backend-resolved value
 * (itself the compiled-in default overlaid with PostHog rollout state).
 */
export function selectFlag(
  state: Pick<FeatureFlagState, "resolved" | "overrides">,
  key: string,
): boolean {
  return state.overrides[key] ?? state.resolved[key] ?? false;
}

/** Effective value of a feature flag. Feature code should gate on this hook. */
export function useFlag(key: FlagKey): boolean {
  return useFeatureFlagStore((state) => selectFlag(state, key));
}
