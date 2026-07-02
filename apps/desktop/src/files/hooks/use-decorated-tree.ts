import { type GitScope, getDecoratedTree } from "@/lib/git-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EMPTY_DECORATIONS,
  type GitDecorations,
  decorationsFromResponse,
} from "../lib/git-status-decoration";

interface UseDecoratedTreeOptions {
  projectId: string | null;
  /** When set, decorations target this run's worktree instead of the project. */
  taskRunId?: string | null;
  /** Skip fetching entirely (e.g. session scope renders the tree undecorated). */
  enabled?: boolean;
  refreshInterval?: number;
}

/**
 * Git status decorations for the file tree, computed by the backend. Mirrors the
 * polling cadence of {@link useGitStatus} (initial fetch + interval, paused when
 * the page is hidden) but returns only the renderer-ready decoration maps.
 */
export function useDecoratedTree({
  projectId,
  taskRunId,
  enabled = true,
  refreshInterval = 5000,
}: UseDecoratedTreeOptions): { decorations: GitDecorations } {
  const scope = useMemo<GitScope | null>(
    () => (taskRunId ? { taskRunId } : projectId ? { projectId } : null),
    [taskRunId, projectId],
  );
  const [decorations, setDecorations] =
    useState<GitDecorations>(EMPTY_DECORATIONS);

  const refresh = useCallback(async () => {
    if (!scope || !enabled) {
      setDecorations(EMPTY_DECORATIONS);
      return;
    }
    try {
      const response = await getDecoratedTree(scope);
      setDecorations(decorationsFromResponse(response.decorations));
    } catch (err) {
      console.error("[use-decorated-tree] Error fetching decorations:", err);
    }
  }, [scope, enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !scope) return;

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    }, refreshInterval);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, scope, refresh, refreshInterval]);

  return { decorations };
}
