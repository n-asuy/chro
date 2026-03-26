import { desktopFetch } from "./backend-client";

interface WorktreeEntryInfo {
  path: string;
  name: string;
  size_bytes: number;
  modified_at: string | null;
}

export interface WorktreeInfoResponse {
  base_dir: string;
  entries: WorktreeEntryInfo[];
  total_size_bytes: number;
}

interface CleanupWorktreesResponse {
  deleted_count: number;
  deleted_paths: string[];
  freed_bytes: number;
}

export const fetchWorktreeInfo = async (): Promise<WorktreeInfoResponse> => {
  return desktopFetch<WorktreeInfoResponse>("/rpc/developer/worktree-info");
};

export const cleanupWorktrees = async (
  paths?: string[],
): Promise<CleanupWorktreesResponse> => {
  return desktopFetch<CleanupWorktreesResponse>(
    "/rpc/developer/worktree-cleanup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: paths ?? null }),
    },
  );
};
