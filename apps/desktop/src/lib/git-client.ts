import type { FileNode } from "@/files/types/file-tree";
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

/** A change kind that can decorate a file or folder. Mirrors the Rust
 * `DecorationStatus` enum (the single source of truth lives in `crates/git`). */
export type DecorationStatus = FileChangeStatus | "untracked";

/**
 * Git status decorations as the backend serializes them: `relativePath -> status`
 * for changed files, and the dominant status rolled up to every ancestor folder.
 * Plain objects on the wire; the consuming hook converts them to `Map`s.
 */
export type GitDecorationMaps = {
  files: Record<string, DecorationStatus>;
  folders: Record<string, DecorationStatus>;
};

/**
 * Working-tree status assembled into a renderer-ready shape by the backend: the
 * raw status, the decoration maps, and the nested changed-files tree — all
 * computed in Rust so the frontend renders without re-deriving any of it.
 */
export type DecoratedTreeResponse = {
  status: GitStatus;
  decorations: GitDecorationMaps;
  changedFilesTree: FileNode[];
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

/**
 * Which working tree a git operation targets: the project's main checkout, or a
 * specific task run's worktree (session sandbox). The backend mirrors the same
 * endpoints under `/projects/:id/git/*` and `/task-runs/:id/git/*`.
 */
export type GitScope = { projectId: string } | { taskRunId: string };

const gitBasePath = (scope: GitScope): string =>
  "taskRunId" in scope
    ? `/rpc/task-runs/${scope.taskRunId}/git`
    : `/rpc/projects/${scope.projectId}/git`;

const postJson = <T>(path: string, body?: unknown): Promise<T> =>
  desktopFetch<T>(path, {
    method: "POST",
    ...(body !== undefined
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });

// --- API Functions ---

export const getGitStatus = async (
  scope: GitScope,
): Promise<GitStatusResponse> => {
  return desktopFetch<GitStatusResponse>(`${gitBasePath(scope)}/status`);
};

/**
 * Fetch the working tree assembled for rendering: status plus the Rust-computed
 * decoration maps and changed-files tree. One call hydrates the whole view.
 */
export const getDecoratedTree = async (
  scope: GitScope,
): Promise<DecoratedTreeResponse> => {
  return desktopFetch<DecoratedTreeResponse>(
    `${gitBasePath(scope)}/decorated-tree`,
  );
};

export const listGitBranches = async (
  scope: GitScope,
): Promise<GitBranchesResult> => {
  const response = await desktopFetch<BranchListResponse>(
    `${gitBasePath(scope)}/branches`,
  );
  return {
    branches: response.branches,
    isRepository: response.isRepository,
  };
};

export const stageFiles = async (
  scope: GitScope,
  paths: string[],
): Promise<GitStatusResponse> => {
  return postJson<GitStatusResponse>(`${gitBasePath(scope)}/stage`, { paths });
};

export const unstageFiles = async (
  scope: GitScope,
  paths: string[],
): Promise<GitStatusResponse> => {
  return postJson<GitStatusResponse>(`${gitBasePath(scope)}/unstage`, {
    paths,
  });
};

export const commitChanges = async (
  scope: GitScope,
  message: string,
): Promise<CommitResponse> => {
  return postJson<CommitResponse>(`${gitBasePath(scope)}/commit`, { message });
};

export const pushChanges = async (
  scope: GitScope,
): Promise<GitStatusResponse> => {
  return postJson<GitStatusResponse>(`${gitBasePath(scope)}/push`);
};

export const pullChanges = async (
  scope: GitScope,
): Promise<GitStatusResponse> => {
  return postJson<GitStatusResponse>(`${gitBasePath(scope)}/pull`);
};

export const discardAllChanges = async (
  scope: GitScope,
): Promise<GitStatusResponse> => {
  return postJson<GitStatusResponse>(`${gitBasePath(scope)}/discard`);
};

export const discardFiles = async (
  scope: GitScope,
  paths: string[],
): Promise<GitStatusResponse> => {
  return postJson<GitStatusResponse>(`${gitBasePath(scope)}/discard-files`, {
    paths,
  });
};

// Project-only: a task-run worktree is always already a repository.
export const initGitRepository = async (
  projectId: string,
): Promise<string | null> => {
  const { branch } = await postJson<CurrentBranchResponse>(
    `/rpc/projects/${projectId}/git/init`,
  );
  return branch;
};

/**
 * Working-tree diffs, each with full before/after content. With no `base`,
 * diffs against HEAD (uncommitted changes only). With a `base` branch ref, diffs
 * against the merge-base of the current branch and that ref — ALL changes the
 * branch introduced (committed + uncommitted) — the "All changes" scope.
 */
export const getWorkingDiffs = async (
  scope: GitScope,
  base?: string,
): Promise<WorkingDiffEntry[]> => {
  const query = base ? `?base=${encodeURIComponent(base)}` : "";
  const response = await desktopFetch<WorkingDiffResponse>(
    `${gitBasePath(scope)}/diff${query}`,
  );
  return response.diffs;
};
