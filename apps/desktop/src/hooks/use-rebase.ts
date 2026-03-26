import { useCallback, useState } from "react";
import { desktopFetch } from "@/lib/backend-client";

type RebaseResult = {
  success: boolean;
  new_base_branch: string;
};

type UseRebaseOptions = {
  taskRunId: string | null;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

type UseRebaseReturn = {
  rebase: (newBaseBranch: string, oldBaseBranch?: string) => Promise<void>;
  isRebasing: boolean;
  error: Error | null;
};

export const useRebase = ({
  taskRunId,
  onSuccess,
  onError,
}: UseRebaseOptions): UseRebaseReturn => {
  const [isRebasing, setIsRebasing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const rebase = useCallback(
    async (newBaseBranch: string, oldBaseBranch?: string) => {
      if (!taskRunId) {
        const err = new Error("Task run ID is required");
        setError(err);
        onError?.(err);
        return;
      }

      setIsRebasing(true);
      setError(null);

      try {
        await desktopFetch<RebaseResult>(
          `/rpc/task-runs/${encodeURIComponent(taskRunId)}/rebase`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              new_base_branch: newBaseBranch,
              old_base_branch: oldBaseBranch ?? newBaseBranch,
            }),
          },
        );
        onSuccess?.();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        onError?.(error);
      } finally {
        setIsRebasing(false);
      }
    },
    [taskRunId, onSuccess, onError],
  );

  return { rebase, isRebasing, error };
};
