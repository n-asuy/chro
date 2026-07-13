import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { useEffect } from "react";
import { create } from "zustand";

/**
 * Persisted flag marking that the user has been through onboarding at least
 * once. Once set, the flow no longer auto-opens on launch; it can still be
 * reopened on demand (e.g. from Settings) via `open()`.
 *
 * The key is kept from the previous single-screen setup modal so users who
 * already completed setup are not shown onboarding again after this redesign.
 */
const ONBOARDING_COMPLETE_KEY = "chro:setup-onboarding-complete";

/**
 * Whether onboarding has been completed. Returns false until UI state has
 * hydrated, so callers should gate on {@link isUiStateReady} before trusting a
 * false result.
 */
export function isOnboardingComplete(): boolean {
  return getUiValue<boolean>(ONBOARDING_COMPLETE_KEY) === true;
}

/** Persist the completion flag. */
export function markOnboardingComplete(): void {
  setUiValue(ONBOARDING_COMPLETE_KEY, true);
}

interface OnboardingStore {
  isOpen: boolean;
  /** Open the flow on demand (does not touch the completion flag). */
  open: () => void;
  /**
   * Mark onboarding done and close the flow. Used by every exit path — finish,
   * skip, or dismiss — since each means the user has acknowledged the flow.
   */
  complete: () => void;
}

export const useOnboardingStore = create<OnboardingStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  complete: () => {
    markOnboardingComplete();
    set({ isOpen: false });
  },
}));

/**
 * Auto-open onboarding on first launch. Waits for persisted UI state to hydrate
 * (it loads asynchronously after first paint) before reading the completion
 * flag, so a returning user never sees the flow flash open.
 */
export function useAutoOpenOnboarding(): void {
  const open = useOnboardingStore((s) => s.open);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (cancelled) return;
      if (!isUiStateReady()) {
        timer = setTimeout(check, 50);
        return;
      }
      if (!isOnboardingComplete()) {
        open();
      }
    };

    check();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open]);
}
