/**
 * Persistence layer for ad-hoc workspace roots ("Add Folder to Project").
 * Each entry stores the absolute path of an extra folder added to the
 * project; it is keyed by projectId so different projects keep distinct
 * worktree lists. Persisted via the backend ui-state RPC.
 */

import { getUiValue, setUiValue } from "@/lib/ui-state-client";

const STORAGE_KEY_PREFIX = "files-extra-worktrees";
const STORAGE_VERSION = 1;

export interface PersistedWorktree {
  /** Absolute filesystem path of the additional worktree. */
  absolutePath: string;
  /** Optional cached display name; recomputed on load if missing. */
  displayName?: string;
}

interface WorktreeState {
  version: number;
  worktrees: PersistedWorktree[];
  lastUpdated: number;
}

function getStorageKey(projectId: string): string {
  return `${STORAGE_KEY_PREFIX}-${projectId}`;
}

export function loadProjectWorktrees(
  projectId: string | null,
): PersistedWorktree[] {
  if (!projectId) return [];
  try {
    const parsed = getUiValue<WorktreeState>(getStorageKey(projectId));
    if (!parsed || parsed.version !== STORAGE_VERSION) return [];
    if (!Array.isArray(parsed.worktrees)) return [];
    return parsed.worktrees.filter(
      (w): w is PersistedWorktree =>
        typeof w?.absolutePath === "string" && w.absolutePath.length > 0,
    );
  } catch {
    return [];
  }
}

export function saveProjectWorktrees(
  projectId: string | null,
  worktrees: PersistedWorktree[],
): void {
  if (!projectId) return;
  try {
    const state: WorktreeState = {
      version: STORAGE_VERSION,
      worktrees,
      lastUpdated: Date.now(),
    };
    setUiValue(getStorageKey(projectId), state);
  } catch {
    // Persistence failures are non-fatal
  }
}
