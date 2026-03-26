import { desktopFetch } from "./backend-client";

export interface DirectoryEntry {
  name: string;
  path: string;
  is_directory: boolean;
  is_git_repo: boolean;
}

export interface DirectoryListResponse {
  entries: DirectoryEntry[];
  current_path: string;
  is_git_repo: boolean;
}

interface CurrentDirectoryResponse {
  path: string;
}

export const filesystemApi = {
  listDirectory: async (path?: string): Promise<DirectoryListResponse> => {
    const queryParam = path ? `?path=${encodeURIComponent(path)}` : "";
    return desktopFetch<DirectoryListResponse>(
      `/rpc/filesystem/directory${queryParam}`,
    );
  },

  getCurrentDirectory: async (): Promise<CurrentDirectoryResponse> => {
    return desktopFetch<CurrentDirectoryResponse>("/rpc/filesystem/cwd");
  },
};
