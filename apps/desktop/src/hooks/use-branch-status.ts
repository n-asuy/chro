import { useCallback, useEffect, useState } from "react";
import { desktopFetch } from "@/lib/backend-client";

type MergeStatus = "open" | "merged" | "closed";

type TaskMerge = {
  id: string;
  task_id: string;
  merge_type: "direct" | "pr";
  target_branch_name: string | null;
  merge_commit: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_status: MergeStatus | null;
  pr_merged_at: string | null;
  pr_merge_commit_sha: string | null;
  created_at: string;
  reverted_at: string | null;
};

export type ConflictOp = "rebase" | "merge" | "cherry_pick" | "revert";

type BranchStatus = {
  commits_ahead: number | null;
  commits_behind: number | null;
  target_branch: string | null;
  is_rebase_in_progress: boolean;
  merges: TaskMerge[];
  conflicted_files: string[];
  conflict_op: ConflictOp | null;
};

type UseBranchStatusOptions = {
  taskRunId: string | null;
  enabled?: boolean;
  pollInterval?: number;
};

type UseBranchStatusReturn = {
  status: BranchStatus | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
};

const DEFAULT_POLL_INTERVAL = 5000;

export const useBranchStatus = ({
  taskRunId,
  enabled = true,
  pollInterval = DEFAULT_POLL_INTERVAL,
}: UseBranchStatusOptions): UseBranchStatusReturn => {
  const [status, setStatus] = useState<BranchStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!taskRunId || !enabled) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await desktopFetch<BranchStatus>(
        `/rpc/task-runs/${encodeURIComponent(taskRunId)}/branch-status`,
      );
      setStatus(response);
    } catch (err) {
      const fetchError = err instanceof Error ? err : new Error(String(err));
      setError(fetchError);
      console.warn("[useBranchStatus] failed to fetch branch status:", fetchError);
    } finally {
      setIsLoading(false);
    }
  }, [taskRunId, enabled]);

  useEffect(() => {
    if (!taskRunId || !enabled) {
      setStatus(null);
      return;
    }

    void fetchStatus();

    const intervalId = setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchStatus();
      }
    }, pollInterval);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void fetchStatus();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [taskRunId, enabled, fetchStatus, pollInterval]);

  return {
    status,
    isLoading,
    error,
    refetch: fetchStatus,
  };
};
