import {
  type TranslationFunction,
  type TranslationKey,
  useLanguage,
} from "@/i18n";
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
import { toast } from "@chro/ui/hooks/use-toast";
import { useCallback, useEffect, useMemo, useState } from "react";

interface UseGitStatusOptions {
  projectId: string | null;
  /**
   * When set, all git operations target this run's worktree (session sandbox)
   * instead of the project's main checkout. Falls back to the project otherwise.
   */
  taskRunId?: string | null;
  autoRefresh?: boolean;
  refreshInterval?: number;
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

const PUSH_REJECT_HINTS = [
  "fetch first",
  "non-fast-forward",
  "remote contains work",
  "failed to push some refs",
  "rejected",
];

const isPushRejected = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("git push") &&
    PUSH_REJECT_HINTS.some((hint) => lower.includes(hint))
  );
};

const GIT_ERROR_MATCHERS: Array<{
  match: (message: string) => boolean;
  key: TranslationKey;
}> = [
  {
    match: (message) =>
      message.includes("authentication failed") ||
      message.includes("could not read username"),
    key: "gitAuthFailed",
  },
  {
    match: (message) =>
      message.includes("permission denied") || message.includes("publickey"),
    key: "gitPermissionDenied",
  },
  {
    match: (message) => message.includes("repository not found"),
    key: "gitRepositoryNotFound",
  },
  {
    match: (message) =>
      message.includes("could not read from remote repository") ||
      message.includes("no such remote"),
    key: "gitRemoteAccessFailed",
  },
  {
    match: (message) =>
      message.includes("no upstream") ||
      message.includes("set upstream") ||
      message.includes("@{u}"),
    key: "gitNoUpstream",
  },
  {
    match: (message) =>
      message.includes("merge conflict") ||
      message.includes("rebase conflict") ||
      message.includes("conflict"),
    key: "gitMergeConflict",
  },
  {
    match: (message) => message.includes("rebase in progress"),
    key: "gitRebaseInProgress",
  },
  {
    match: (message) => message.includes("not a git repository"),
    key: "gitNotRepository",
  },
  {
    match: (message) =>
      message.includes("could not resolve host") ||
      message.includes("failed to connect") ||
      message.includes("connection timed out") ||
      message.includes("unable to access"),
    key: "gitNetworkError",
  },
  {
    match: (message) => message.includes("local changes would be overwritten"),
    key: "gitLocalChanges",
  },
];

const normalizeGitErrorMessage = (message: string): string =>
  message.replace(/^bad request:\s*/i, "").trim();

const resolveGitError = (
  err: unknown,
  t: TranslationFunction,
  fallbackKey: TranslationKey,
): {
  message: string;
} => {
  const rawMessage = err instanceof Error ? err.message : "";
  const normalizedMessage = normalizeGitErrorMessage(rawMessage);
  const lower = normalizedMessage.toLowerCase();

  if (isPushRejected(lower)) {
    return {
      message: t("gitPushRejectedDescription"),
    };
  }

  const matched = GIT_ERROR_MATCHERS.find((matcher) => matcher.match(lower));
  if (matched) {
    return { message: t(matched.key) };
  }

  if (normalizedMessage) {
    return {
      message: t("gitErrorWithDetails", { message: normalizedMessage }),
    };
  }

  return { message: t(fallbackKey) };
};

export function useGitStatus({
  projectId,
  taskRunId,
  autoRefresh = true,
  refreshInterval = 5000,
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
      const { message } = resolveGitError(err, t, "gitStatusFailed");
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
        const { message } = resolveGitError(err, t, "gitStageFailed");
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
        const { message } = resolveGitError(err, t, "gitUnstageFailed");
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
        const { message } = resolveGitError(err, t, "gitCommitFailed");
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
      const { message } = resolveGitError(err, t, "gitPushFailed");
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
      const { message } = resolveGitError(err, t, "gitPullFailed");
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
      const { message } = resolveGitError(err, t, "gitDiscardFailed");
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
        const { message } = resolveGitError(err, t, "gitDiscardFilesFailed");
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

  // Auto-refresh interval (paused when page is not visible)
  useEffect(() => {
    if (!autoRefresh || !scope) return;

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
  }, [autoRefresh, scope, refresh, refreshInterval]);

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
