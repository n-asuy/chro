import { OPEN_FEEDBACK_EVENT } from "@/feedback/feedback-popover";
import { useSettingsModal } from "@/settings/components/settings-modal-provider";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/** Must match `APP_VIEW_EVENT` in the Tauri shell. */
const APP_VIEW_EVENT = "app:open-view";

/** Must match `AppView` in the Tauri shell. */
type AppView = "settings" | "feedback";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // @ts-expect-error — Tauri 2 marks its globals at startup
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

/**
 * Opens a view of this window asked for from outside it: the edge toolbar's
 * "…" menu. The shell focuses this window and emits `app:open-view`; Settings
 * opens its modal, Feedback opens the header's feedback popover. Mounted once
 * inside the settings modal provider.
 */
export function useAppViewRequests(): void {
  const { open: openSettings } = useSettingsModal();
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<AppView>(APP_VIEW_EVENT, (event) => {
      if (event.payload === "settings") openSettings();
      else window.dispatchEvent(new Event(OPEN_FEEDBACK_EVENT));
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [openSettings]);
}
