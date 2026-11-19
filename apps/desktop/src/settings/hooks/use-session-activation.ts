import type { SessionNotificationTarget } from "@/settings/lib/notification-target";
import { useNavigate } from "@tanstack/react-router";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/** Must match `SESSION_ACTIVATE_EVENT` in the Tauri shell. */
const SESSION_ACTIVATE_EVENT = "session:activate";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    // @ts-expect-error — Tauri 2 marks its globals at startup
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

/**
 * Opens a session that was pointed at from outside this window: a clicked
 * desktop notification, or "Open in chro" in the edge toolbar. The Rust shell
 * focuses this window and emits `session:activate` to it carrying the task's
 * route params; this hook performs the in-app navigation. Mounted once at the
 * root, inside the router so `useNavigate` is available.
 */
export function useSessionActivation(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<SessionNotificationTarget>(
      SESSION_ACTIVATE_EVENT,
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
