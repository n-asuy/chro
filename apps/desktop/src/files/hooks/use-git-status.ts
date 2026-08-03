import { useRepoEvents } from "@/hooks/use-repo-events";
import { useLanguage } from "@/i18n";
import {
  type GitScope,
  type GitStatus,
  type GitStatusResponse,
  commitChanges,
  discardAllChanges,
  discardFiles as discardFilesApi,
  getGitStatus,
  pullChanges,
  pushChanges,
  stageFiles,
  unstageFiles,
} from "@/lib/git-client";
import { resolveGitError } from "@/lib/git-error";
import { toast } from "@chro/ui/hooks/use-toast";
import { useCallback, useEffect, useMemo, useState } from "react";

interface UseGitStatusOptions {
  projectId: string | null;
  /**
   * When set, all git operations target this run's worktree (session sandbox)
   * instead of the project's main checkout. Falls back to the project otherwise.
   */
  taskRunId?: string | null;
  /** Whether the status follows worktree/git change events automatically. */
  autoRefresh?: boolean;
}

interface UseGitStatusReturn {
  status: GitStatus | null;
  currentBranch: string | null;
  commitsAhead: number;
  commitsBehind: number;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<string | null>;
  push: () => Promise<void>;
  pull: () => Promise<void>;
  discard: () => Promise<void>;
  discardFiles: (paths: string[]) => Promise<void>;
}

const EMPTY_STATUS: GitStatus = {
  staged: [],
  modified: [],
  untracked: [],
  hasChanges: false,
};

export function useGitStatus({
  projectId,
  taskRunId,
  autoRefresh = true,
}: UseGitStatusOptions): UseGitStatusReturn {
  const { t } = useLanguage();

  // Resolve the target working tree: the run's worktree when scoped to a
  // session, otherwise the project checkout.
  const scope = useMemo<GitScope | null>(
    () => (taskRunId ? { taskRunId } : projectId ? { projectId } : null),
    [taskRunId, projectId],
  );
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [commitsAhead, setCommitsAhead] = useState(0);
  const [commitsBehind, setCommitsBehind] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showGitErrorToast = useCallback((message: string) => {
    toast({
      title: message,
      variant: "warning",
    });
  }, []);

  const applyStatusResponse = useCallback((response: GitStatusResponse) => {
    setStatus(response.status);
    setCurrentBranch(response.currentBranch);
    setCommitsAhead(response.commitsAhead);
    setCommitsBehind(response.commitsBehind);
  }, []);

  const refresh = useCallback(async () => {
    if (!scope) {
      setStatus(null);
      setCurrentBranch(null);
      setCommitsAhead(0);
      setCommitsBehind(0);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const response = await getGitStatus(scope);
      applyStatusResponse(response);
    } catch (err) {
      const message = resolveGitError(err, t, "gitStatusFailed");
      setError(message);
      console.error("[use-git-status] Error fetching status:", err);
    } finally {
      setIsLoading(false);
    }
  }, [applyStatusResponse, scope, t]);

  const stage = useCallback(
    async (paths: string[]) => {
      if (!scope || paths.length === 0) return;

      try {
        setError(null);
        const response = await stageFiles(scope, paths);
        applyStatusResponse(response);
      } catch (err) {
        const message = resolveGitError(err, t, "gitStageFailed");
        setError(message);
        showGitErrorToast(message);
        return;
      }
    },
    [applyStatusResponse, scope, showGitErrorToast, t],
  );

  const unstage = useCallback(
    async (paths: string[]) => {
      if (!scope || paths.length === 0) return;

      try {
        setError(null);
        const response = await unstageFiles(scope, paths);
        applyStatusResponse(response);
      } catch (err) {
        const message = resolveGitError(err, t, "gitUnstageFailed");
        setError(message);
        showGitErrorToast(message);
        return;
      }
    },
    [applyStatusResponse, scope, showGitErrorToast, t],
  );

  const commit = useCallback(
    async (message: string): Promise<string | null> => {
      if (!scope || !message.trim()) return null;

      try {
        setError(null);
        const response = await commitChanges(scope, message);
        // Refresh status after commit
        await refresh();
        return response.commitSha;
      } catch (err) {
        const message = resolveGitError(err, t, "gitCommitFailed");
        setError(message);
        showGitErrorToast(message);
        return null;
      }
    },
    [scope, refresh, showGitErrorToast, t],
  );

  const push = useCallback(async () => {
    if (!scope) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await pushChanges(scope);
      applyStatusResponse(response);
      toast({
        title: t("gitPushSuccessTitle"),
      });
    } catch (err) {
      const message = resolveGitError(err, t, "gitPushFailed");
      setError(message);
      showGitErrorToast(message);
      return;
    } finally {
      setIsLoading(false);
    }
  }, [applyStatusResponse, scope, showGitErrorToast, t]);

  const pull = useCallback(async () => {
    if (!scope) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await pullChanges(scope);
      applyStatusResponse(response);
      toast({
        title: t("gitPullSuccessTitle"),
      });
    } catch (err) {
      const message = resolveGitError(err, t, "gitPullFailed");
      setError(message);
      showGitErrorToast(message);
      return;
    } finally {
      setIsLoading(false);
    }
  }, [applyStatusResponse, scope, showGitErrorToast, t]);

  const discard = useCallback(async () => {
    if (!scope) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await discardAllChanges(scope);
      applyStatusResponse(response);
    } catch (err) {
      const message = resolveGitError(err, t, "gitDiscardFailed");
      setError(message);
      showGitErrorToast(message);
      return;
    } finally {
      setIsLoading(false);
    }
  }, [applyStatusResponse, scope, showGitErrorToast, t]);

  const discardFiles = useCallback(
    async (paths: string[]) => {
      if (!scope || paths.length === 0) return;

      try {
        setError(null);
        const response = await discardFilesApi(scope, paths);
        applyStatusResponse(response);
      } catch (err) {
        const message = resolveGitError(err, t, "gitDiscardFilesFailed");
        setError(message);
        showGitErrorToast(message);
        return;
      }
    },
    [applyStatusResponse, scope, showGitErrorToast, t],
  );

  // Initial fetch
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Working-tree status derives from file changes plus git state (index,
  // HEAD, in-progress operations), so change events replace the previous
  // interval polling.
  useRepoEvents(autoRefresh && scope ? scope : undefined, {
    channels: ["files", "git"],
    onInvalidate: () => void refresh(),
  });

  // A visibility refresh covers changes made while the window was hidden on a
  // lagging stream.
  useEffect(() => {
    if (!autoRefresh || !scope) return;

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [autoRefresh, scope, refresh]);

  return {
    status,
    currentBranch,
    commitsAhead,
    commitsBehind,
    isLoading,
    error,
    refresh,
    stage,
    unstage,
    commit,
    push,
    pull,
    discard,
    discardFiles,
  };
}
