import { selectFlag, useFeatureFlagStore } from "@/lib/feature-flags-store";
import { useEffect } from "react";
import { setEdgeToolbarEnabled } from "./lib/edge-window-client";

/**
 * Tell `apply` whether the edge toolbar window should exist now and on every
 * change of the `edge_toolbar` flag: the beta switch in Settings (opt-in, so
 * off until the user turns it on), the backend offering it, or a developer
 * force. Returns the unsubscribe function.
 */
export function followEdgeToolbarFlag(
  apply: (enabled: boolean) => void,
): () => void {
  let current = selectFlag(useFeatureFlagStore.getState(), "edge_toolbar");
  apply(current);
  return useFeatureFlagStore.subscribe((state) => {
    const next = selectFlag(state, "edge_toolbar");
    if (next === current) return;
    current = next;
    apply(next);
  });
}

/**
 * Mounted in every session window: tells the shell whether the edge toolbar
 * window should exist, so switching the beta on or off in Settings creates or
 * closes it at once. The flag resolves in the renderer (the switch and
 * developer overrides live in its storage), so the shell cannot decide on its
 * own; with the flag off the window is never built.
 */
export function EdgeToolbarHost(): null {
  useEffect(() => followEdgeToolbarFlag(setEdgeToolbarEnabled), []);
  return null;
}
