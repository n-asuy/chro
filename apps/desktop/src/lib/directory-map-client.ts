import { desktopFetch, getBackendBaseUrl } from "@/lib/backend-client";
import type { DirectoryTreeEntry } from "@/workspace-layout/domain/directory-tree";

/**
 * Client for the directory map: a project's main checkout as a
 * gitignore-filtered tree, and the standing agent of one directory in it.
 */

export interface ProjectTree {
  entries: DirectoryTreeEntry[];
  /** True when the checkout exceeds the index cap and `entries` is empty. */
  overflowed: boolean;
}

export const fetchProjectTree = (projectId: string): Promise<ProjectTree> =>
  desktopFetch<ProjectTree>(
    `/rpc/projects/${encodeURIComponent(projectId)}/tree`,
  );

/** Reconnects after a backend restart; each connection announces its current index. */
export function subscribeProjectTree(
  projectId: string,
  onUpdated: () => void,
): () => void {
  const base = getBackendBaseUrl().replace(/\/$/, "").replace(/^http/, "ws");
  const url = `${base}/rpc/projects/${encodeURIComponent(projectId)}/tree-events`;
  let stopped = false;
  let socket: WebSocket;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = 1000;
  const connect = () => {
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      if (event.data === "updated") {
        retryDelay = 1000;
        onUpdated();
      }
    };
    socket.onclose = () => {
      if (stopped) return;
      retry = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    socket.onmessage = null;
    socket.onclose = null;
    socket.close();
  };
}

export type LedgerOutcome = "merged" | "completed" | "failed" | "archived";

export interface LedgerEntry {
  taskId: string;
  slug: string | null;
  title: string;
  summary: string | null;
  outcome: LedgerOutcome;
  updatedAt: string;
}

export interface DirectoryAgent {
  /** Repo-relative directory (`""` is the root). */
  path: string;
  /** The brief file inside this directory, if any. */
  brief: { path: string } | null;
  /** The nearest ancestor's brief, governing when `brief` is absent. */
  inheritedBrief: { path: string } | null;
  /** Finished sessions addressed to this directory, most recent first. */
  ledger: LedgerEntry[];
}

export const fetchDirectoryAgent = (
  projectId: string,
  path: string,
): Promise<DirectoryAgent> => {
  const query = new URLSearchParams({ path });
  return desktopFetch<DirectoryAgent>(
    `/rpc/projects/${encodeURIComponent(projectId)}/directory-agent?${query}`,
  );
};
