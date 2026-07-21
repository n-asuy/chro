import { desktopFetch } from "@/lib/backend-client";
import { useCallback, useState } from "react";

type MergeResult = {
  merge_commit: string;
  target_branch: string;
};

type UseMergeRunOptions = {
  taskRunId: string | null;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

type UseMergeRunReturn = {
  merge: () => Promise<void>;
  isMerging: boolean;
  /** True for a short window after a successful merge, to confirm the action. */
  didMerge: boolean;
  error: Error | null;
};

const SUCCESS_FLASH_MS = 2000;

/**
 * Merge a task run's branch into its target. Sibling of {@link useRebase}: both
 * are integration verbs owned by whichever surface shows the run's changes, so
 * the panel that lists those changes can drive them without prop-drilling from
 * the session view.
 */
export const useMergeRun = ({
  taskRunId,
  onSuccess,
  onError,
}: UseMergeRunOptions): UseMergeRunReturn => {
  const [isMerging, setIsMerging] = useState(false);
  const [didMerge, setDidMerge] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const merge = useCallback(async () => {
    if (!taskRunId) {
      const err = new Error("Task run ID is required");
      setError(err);
      onError?.(err);
      return;
    }

    setIsMerging(true);
    setError(null);
    try {
      await desktopFetch<MergeResult>(
        `/rpc/task-runs/${encodeURIComponent(taskRunId)}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      setDidMerge(true);
      setTimeout(() => setDidMerge(false), SUCCESS_FLASH_MS);
      onSuccess?.();
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      setError(wrapped);
      onError?.(wrapped);
    } finally {
      setIsMerging(false);
    }
  }, [onError, onSuccess, taskRunId]);

  return { merge, isMerging, didMerge, error };
};
