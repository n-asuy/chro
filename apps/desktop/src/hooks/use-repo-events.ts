/**
 * React binding for the repo-events notification stream: replaces interval
 * polling with watcher-driven invalidation. See lib/repo-events for the
 * framework-free core and the message protocol.
 */
import { useEffect, useRef } from "react";
import type { GitScope } from "@/lib/git-client";
import {
  type RepoEventsConfig,
  repoEventsEndpoint,
  subscribeRepoEvents,
} from "@/lib/repo-events";

export interface UseRepoEventsOptions extends RepoEventsConfig {
  enabled?: boolean;
}

/**
 * Subscribe to `scope`'s repo-events and call `onInvalidate` (debounced) on
 * every relevant change. Callbacks and filters are read fresh on each event;
 * only the scope identity and `enabled` control the subscription lifecycle.
 */
export function useRepoEvents(
  scope: GitScope | undefined,
  options: UseRepoEventsOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const enabled = options.enabled !== false;
  const scopeKey = !scope
    ? undefined
    : "taskRunId" in scope
      ? `task-run:${scope.taskRunId}`
      : `project:${scope.projectId}`;

  useEffect(() => {
    if (!scopeKey || !scope || !enabled) return;
    return subscribeRepoEvents(
      repoEventsEndpoint(scope),
      () => optionsRef.current,
    );
    // The endpoint is fully determined by scopeKey; scope itself may be a
    // fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, enabled]);
}
