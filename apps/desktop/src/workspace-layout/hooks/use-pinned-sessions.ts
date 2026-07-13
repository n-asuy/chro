import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { useCallback, useEffect, useState } from "react";

/**
 * Pinning is a per-user sidebar *view* preference, not intrinsic task state, so
 * it lives in UI state alongside the sort/group choices rather than as a task
 * column. Keeping it out of the task row avoids a DB migration and, crucially,
 * the JSON-patch/`updated_at` ordering races that a streamed `pinned_at` column
 * would introduce. The value is a map of taskId -> ISO pin time so the Pinned
 * section can order by when each item was pinned.
 */
const STORAGE_KEY = "workspace-layout:pinned-sessions:v1";

export type PinMap = Record<string, string>;

function readPins(): PinMap {
  const value = getUiValue<unknown>(STORAGE_KEY);
  if (!value || typeof value !== "object") return {};
  const out: PinMap = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === "string") out[id] = at;
  }
  return out;
}

export interface PinnedSessions {
  pins: PinMap;
  isPinned: (taskId: string) => boolean;
  togglePin: (taskId: string) => void;
}

export function usePinnedSessions(): PinnedSessions {
  const [pins, setPins] = useState<PinMap>(readPins);
  const [userChanged, setUserChanged] = useState(false);

  // Hydrate from persisted UI state once it is ready, unless the user already
  // toggled a pin this session (mirrors usePersistedChoice in projects-panel).
  useEffect(() => {
    const hydrate = () => {
      if (!isUiStateReady()) return false;
      if (!userChanged) setPins(readPins());
      return true;
    };
    if (hydrate()) return;
    const id = window.setInterval(() => {
      if (hydrate()) window.clearInterval(id);
    }, 50);
    return () => window.clearInterval(id);
  }, [userChanged]);

  const togglePin = useCallback((taskId: string) => {
    setUserChanged(true);
    setPins((prev) => {
      const next = { ...prev };
      if (next[taskId]) delete next[taskId];
      else next[taskId] = new Date().toISOString();
      setUiValue(STORAGE_KEY, next);
      return next;
    });
  }, []);

  const isPinned = useCallback(
    (taskId: string) => Boolean(pins[taskId]),
    [pins],
  );

  return { pins, isPinned, togglePin };
}
