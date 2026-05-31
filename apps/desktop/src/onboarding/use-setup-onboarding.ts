import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { useEffect } from "react";
import { create } from "zustand";

/**
 * Persisted flag marking that the user has seen the git/agent setup screen at
 * least once. Once set, the setup modal no longer auto-opens on launch; it can
 * still be reopened on demand (e.g. from Settings) via `open()`.
 */
const SETUP_COMPLETE_KEY = "chro:setup-onboarding-complete";

interface SetupOnboardingStore {
  isOpen: boolean;
  /** Open the setup modal on demand (does not touch the completion flag). */
  open: () => void;
  /**
   * Mark setup as done and close the modal. Used by both "Continue" and
   * "Skip for now" — either way the user has acknowledged the screen.
   */
  complete: () => void;
}

export const useSetupOnboardingStore = create<SetupOnboardingStore>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  complete: () => {
    setUiValue(SETUP_COMPLETE_KEY, true);
    set({ isOpen: false });
  },
}));

/**
 * Auto-open the setup modal on first launch. Waits for the persisted UI state
 * to hydrate (it loads asynchronously after first paint) before reading the
 * completion flag, so a returning user never sees the modal flash open.
 */
export function useAutoOpenSetupOnboarding(): void {
  const open = useSetupOnboardingStore((s) => s.open);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (cancelled) return;
      if (!isUiStateReady()) {
        timer = setTimeout(check, 50);
        return;
      }
      if (getUiValue<boolean>(SETUP_COMPLETE_KEY) !== true) {
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
