import { create } from "zustand";
import { fetchFlagRegistry } from "./flags-client";
import { FLAG_DEFAULTS, type FlagKey } from "./flags.generated";

/**
 * Beta features the user has switched off on this machine. Stored in
 * `localStorage` rather than the backend ui-state so it is readable
 * synchronously on the first render, like the compiled-in defaults it sits on
 * top of.
 *
 * Opt-*outs* only: whether a feature is offered at all is resolved by the
 * backend, and a user-facing "force on" that outranked it would let a machine
 * keep a feature after it had been killed for everyone, which is the one
 * property the kill switch has to have.
 */
export const BETA_OPT_OUTS_STORAGE_KEY = "chro:beta-features-off";

/**
 * Developer-forced values, dev builds only. Release builds never read this
 * key and expose no way to write it, so the kill-switch property above still
 * holds for every shipped binary. Set from the devtools console via
 * `window.chroFlags` (see `flags-dev-console.ts`).
 */
export const DEV_FLAG_OVERRIDES_STORAGE_KEY = "chro:dev-flag-overrides";

export function readPersistedOptOuts(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BETA_OPT_OUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((key): key is string => typeof key === "string");
  } catch {
    // Unparsable, or localStorage unavailable in a restricted webview.
    return [];
  }
}

function persistOptOuts(keys: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      BETA_OPT_OUTS_STORAGE_KEY,
      JSON.stringify(keys),
    );
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

export function readPersistedDevOverrides(): Record<string, boolean> {
  if (!import.meta.env.DEV) return {};
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(DEV_FLAG_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const overrides: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") overrides[key] = value;
    }
    return overrides;
  } catch {
    return {};
  }
}

function persistDevOverrides(overrides: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      DEV_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify(overrides),
    );
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

interface FeatureFlagState {
  /** Compiled-in defaults, overlaid with the backend's resolved values. */
  resolved: Record<string, boolean>;
  /** Keys the user switched off; only meaningful for a resolved-on flag. */
  optedOut: string[];
  /** Developer-forced values; always empty in release builds. */
  devOverrides: Record<string, boolean>;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  /**
   * Switch a beta feature on or off for this machine. Switching *on* only
   * clears an opt-out, so it can never turn on a feature the backend has not
   * resolved on.
   *
   * Keyed by `string` rather than `FlagKey`: the caller is the settings
   * section walking its own list of user-facing features. Gating a feature is
   * the hand-authored case, and `useFlag` narrows that one.
   */
  setBetaEnabled: (key: string, enabled: boolean) => void;
  /**
   * Force a flag for development; `null` removes the force. A no-op in
   * release builds.
   */
  setDevOverride: (key: string, value: boolean | null) => void;
  clearDevOverrides: () => void;
}

export const useFeatureFlagStore = create<FeatureFlagState>()((set, get) => ({
  resolved: { ...FLAG_DEFAULTS },
  optedOut: readPersistedOptOuts(),
  devOverrides: readPersistedDevOverrides(),
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const flags = await fetchFlagRegistry();
      const resolved: Record<string, boolean> = { ...FLAG_DEFAULTS };
      for (const flag of flags) {
        resolved[flag.key] = flag.enabled;
      }
      set({ resolved, loaded: true, loading: false });
    } catch {
      // Keep the compiled-in defaults: the backend resolves to those on any
      // failure, so an unreachable registry must land on the same value.
      set({ loading: false });
    }
  },

  setBetaEnabled: (key, enabled) => {
    const optedOut = enabled
      ? get().optedOut.filter((entry) => entry !== key)
      : [...new Set([...get().optedOut, key])];
    persistOptOuts(optedOut);
    set({ optedOut });
  },

  setDevOverride: (key, value) => {
    if (!import.meta.env.DEV) return;
    const devOverrides = { ...get().devOverrides };
    if (value === null) {
      delete devOverrides[key];
    } else {
      devOverrides[key] = value;
    }
    persistDevOverrides(devOverrides);
    set({ devOverrides });
  },

  clearDevOverrides: () => {
    if (!import.meta.env.DEV) return;
    persistDevOverrides({});
    set({ devOverrides: {} });
  },
}));

/**
 * Precedence: a developer force (dev builds only) wins outright; otherwise
 * the backend decides whether the feature is offered at all, and the user can
 * only switch an offered feature off.
 */
export function selectFlag(
  state: Pick<FeatureFlagState, "resolved" | "optedOut" | "devOverrides">,
  key: string,
): boolean {
  const forced = state.devOverrides[key];
  if (forced !== undefined) return forced;
  if (!(state.resolved[key] ?? false)) return false;
  return !state.optedOut.includes(key);
}

/** Effective value of a feature flag. Feature code should gate on this hook. */
export function useFlag(key: FlagKey): boolean {
  return useFeatureFlagStore((state) => selectFlag(state, key));
}
