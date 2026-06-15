import {
  type BranchInfo,
  initGitRepository,
  listGitBranches,
} from "@/lib/git-client";
import { useCallback, useEffect, useMemo, useState } from "react";

type UseSessionExecutionOptionsArgs = {
  routeProjectId: string | null;
  addErrorMessage: (message: string) => void;
};

type UseSessionExecutionOptionsResult = {
  useWorktree: boolean;
  setUseWorktree: (next: boolean) => void;
  isGitRepository: boolean;
  baseBranch: string | null;
  setBaseBranch: (next: string | null) => void;
  baseBranchCandidates: BranchInfo[];
  isLoadingBaseBranches: boolean;
  baseBranchSearch: string;
  setBaseBranchSearch: (next: string) => void;
  filteredBaseBranches: BranchInfo[];
  isInitializingGit: boolean;
  handleInitGitRepo: () => Promise<void>;
};

const toLocalBranches = (branches: BranchInfo[]) =>
  branches.filter((branch) => !branch.is_remote);

export function useSessionExecutionOptions({
  routeProjectId,
  addErrorMessage,
}: UseSessionExecutionOptionsArgs): UseSessionExecutionOptionsResult {
  const [useWorktree, setUseWorktree] = useState(true);
  const [isGitRepository, setIsGitRepository] = useState(true);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [baseBranchCandidates, setBaseBranchCandidates] = useState<
    BranchInfo[]
  >([]);
  const [isLoadingBaseBranches, setIsLoadingBaseBranches] = useState(true);
  const [baseBranchSearch, setBaseBranchSearch] = useState("");
  const [isInitializingGit, setIsInitializingGit] = useState(false);

  const filteredBaseBranches = useMemo(() => {
    const query = baseBranchSearch.trim().toLowerCase();
    if (!query) return baseBranchCandidates;
    return baseBranchCandidates.filter((branch) =>
      branch.name.toLowerCase().includes(query),
    );
  }, [baseBranchCandidates, baseBranchSearch]);

  useEffect(() => {
    setUseWorktree(true);
    setIsGitRepository(true);
  }, [routeProjectId]);

  useEffect(() => {
    if (!routeProjectId) {
      setBaseBranchCandidates([]);
      setBaseBranch(null);
      setIsGitRepository(true);
      setIsLoadingBaseBranches(false);
      return;
    }

    let cancelled = false;
    setIsLoadingBaseBranches(true);

    listGitBranches({ projectId: routeProjectId })
      .then(({ branches, isRepository }) => {
        if (cancelled) return;
        setIsGitRepository(isRepository);
        if (!isRepository) {
          setUseWorktree(false);
          setBaseBranchCandidates([]);
          setBaseBranch(null);
          return;
        }
        const localBranches = toLocalBranches(branches);
        setBaseBranchCandidates(localBranches);
        setBaseBranch((previous) => {
          if (
            previous &&
            localBranches.some((branch) => branch.name === previous)
          ) {
            return previous;
          }
          const current = localBranches.find((branch) => branch.is_current);
          return current?.name ?? previous ?? null;
        });
      })
      .catch((error) => {
        console.error("[SingleAgentSession] Failed to fetch branches", error);
        if (!cancelled) {
          setBaseBranchCandidates([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingBaseBranches(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [routeProjectId]);

  const handleInitGitRepo = useCallback(async () => {
    if (!routeProjectId || isInitializingGit) return;
    setIsInitializingGit(true);
    try {
      await initGitRepository(routeProjectId);
      const { branches, isRepository } = await listGitBranches({
        projectId: routeProjectId,
      });
      setIsGitRepository(isRepository);
      const localBranches = toLocalBranches(branches);
      setBaseBranchCandidates(localBranches);
      setBaseBranch((previous) => {
        if (
          previous &&
          localBranches.some((branch) => branch.name === previous)
        ) {
          return previous;
        }
        const current = localBranches.find((branch) => branch.is_current);
        return current?.name ?? previous ?? null;
      });
    } catch (error) {
      console.error("[session] Failed to initialize git repository", error);
      if (error instanceof Error) {
        addErrorMessage(error.message);
      }
    } finally {
      setIsInitializingGit(false);
    }
  }, [routeProjectId, isInitializingGit, addErrorMessage]);

  return {
    useWorktree,
    setUseWorktree,
    isGitRepository,
    baseBranch,
    setBaseBranch,
    baseBranchCandidates,
    isLoadingBaseBranches,
    baseBranchSearch,
    setBaseBranchSearch,
    filteredBaseBranches,
    isInitializingGit,
    handleInitGitRepo,
  };
}
