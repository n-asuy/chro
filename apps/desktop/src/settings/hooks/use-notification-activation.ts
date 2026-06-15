import type { SessionNotificationTarget } from "@/settings/lib/notification-target";
import { useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/** Must match `NOTIFICATION_ACTIVATE_EVENT` in the Tauri shell. */
const NOTIFICATION_ACTIVATE_EVENT = "notification:activate";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // @ts-expect-error — Tauri 2 marks its globals at startup
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

/**
 * Opens the originating session when a desktop notification is clicked. The
 * Rust shell focuses the window and emits `notification:activate` carrying the
 * task's route params; this hook performs the in-app navigation. Mounted once
 * at the root, inside the router so `useNavigate` is available.
 */
export function useNotificationActivation(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<SessionNotificationTarget>(
      NOTIFICATION_ACTIVATE_EVENT,
      (event) => {
        const { projectId, taskId } = event.payload;
        if (!projectId || !taskId) return;
        void navigate({
          to: "/projects/$projectId/session/$taskId",
          params: { projectId, taskId },
        });
      },
    );
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [navigate]);
}
