import type { DiffContent } from "@/session/hooks";
import { desktopFetch } from "./backend-client";

// --- Types ---

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange";

export type FileChange = {
  path: string;
  status: FileChangeStatus;
};

export type GitStatus = {
  staged: FileChange[];
  modified: FileChange[];
  untracked: string[];
  hasChanges: boolean;
};

export type GitStatusResponse = {
  status: GitStatus;
  currentBranch: string | null;
  commitsAhead: number;
  commitsBehind: number;
};

export type BranchInfo = {
  name: string;
  is_current: boolean;
  is_remote: boolean;
  last_commit_timestamp: number | null;
};

type BranchListResponse = {
  branches: BranchInfo[];
  isRepository: boolean;
};

export type GitBranchesResult = {
  branches: BranchInfo[];
  isRepository: boolean;
};

type CurrentBranchResponse = {
  branch: string | null;
};

type CommitResponse = {
  commitSha: string | null;
};

/**
 * A single changed file in the project working tree, paired with its full
 * before/after content. Shares the `DiffContent` shape used by task-run diffs
 * so the same DiffViewerPanel renders both.
 */
export type WorkingDiffEntry = {
  path: string;
  diff: DiffContent;
};

type WorkingDiffResponse = {
  diffs: WorkingDiffEntry[];
};

// --- API Functions ---

export const getGitStatus = async (
  projectId: string,
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(
    `/rpc/projects/${projectId}/git/status`,
  );
};

export const listGitBranches = async (
  projectId: string,
): Promise<GitBranchesResult> => {
  const response = await desktopFetch<BranchListResponse>(
    `/rpc/projects/${projectId}/git/branches`,
  );
  return {
    branches: response.branches,
    isRepository: response.isRepository,
  };
};

export const stageFiles = async (
  projectId: string,
  paths: string[],
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(
    `/rpc/projects/${projectId}/git/stage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    },
  );
};

export const unstageFiles = async (
  projectId: string,
  paths: string[],
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(
    `/rpc/projects/${projectId}/git/unstage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    },
  );
};

export const commitChanges = async (
  projectId: string,
  message: string,
): Promise<CommitResponse> => {
  return desktopFetch<CommitResponse>(`/rpc/projects/${projectId}/git/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
};

export const pushChanges = async (
  projectId: string,
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(
    `/rpc/projects/${projectId}/git/push`,
    {
      method: "POST",
    },
  );
};

export const pullChanges = async (
  projectId: string,
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(
    `/rpc/projects/${projectId}/git/pull`,
    {
      method: "POST",
    },
  );
};

export const discardAllChanges = async (
  projectId: string,
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(
    `/rpc/projects/${projectId}/git/discard`,
    {
      method: "POST",
    },
  );
};

export const initGitRepository = async (
  projectId: string,
): Promise<string | null> => {
  const { branch } = await desktopFetch<CurrentBranchResponse>(
    `/rpc/projects/${projectId}/git/init`,
    {
      method: "POST",
    },
  );
  return branch;
};

export const discardFiles = async (
  projectId: string,
  paths: string[],
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(
    `/rpc/projects/${projectId}/git/discard-files`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    },
  );
};

/**
 * Working-tree diffs against HEAD (including untracked files), each with full
 * before/after content. Feeds the working-changes diff tab and the per-file
 * +/- counts shown in the source-control panel.
 */
export const getWorkingDiffs = async (
  projectId: string,
): Promise<WorkingDiffEntry[]> => {
  const response = await desktopFetch<WorkingDiffResponse>(
    `/rpc/projects/${projectId}/git/diff`,
  );
  return response.diffs;
};
