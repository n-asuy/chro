import type { FileSearchResult } from "@/files/lib/file-search";
import type { StoredTask } from "@/session/types";

// ---------------------------------------------------------------------------
// Result types (also used by the provider)
// ---------------------------------------------------------------------------

type SessionResult = {
  category: "session";
  task: StoredTask;
};

type FileResult = {
  category: "file";
  file: FileSearchResult;
};

export type SearchResultItem = SessionResult | FileResult;

// ---------------------------------------------------------------------------
// Session filtering (client-side, synchronous)
// ---------------------------------------------------------------------------

const MAX_SESSION_RESULTS = 10;

export function filterSessions(
  tasks: StoredTask[],
  query: string,
): SessionResult[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed || !tasks.length) return [];
  return tasks
    .filter((task) => task.title?.toLowerCase().includes(trimmed))
    .slice(0, MAX_SESSION_RESULTS)
    .map((task) => ({ category: "session" as const, task }));
}

// ---------------------------------------------------------------------------
// Result merging
// ---------------------------------------------------------------------------

export function mergeResults(
  sessions: SessionResult[],
  files: FileSearchResult[],
): SearchResultItem[] {
  const fileItems: FileResult[] = files.map((file) => ({
    category: "file" as const,
    file,
  }));
  return [...sessions, ...fileItems];
}

// ---------------------------------------------------------------------------
// Request ID guard (race-condition prevention)
// ---------------------------------------------------------------------------

export type SearchIdRef = { current: number };

/**
 * Increment the search ID and return the new value.
 * Used both when starting a new search and when clearing the query.
 */
export function nextSearchId(ref: SearchIdRef): number {
  return ++ref.current;
}

/**
 * Check whether a response is still current.
 * Returns false if a newer request has been issued since `requestId` was created.
 */
export function isCurrentRequest(ref: SearchIdRef, requestId: number): boolean {
  return requestId === ref.current;
}
