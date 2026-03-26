/**
 * Tree state persistence layer for vault file tree.
 * Persists expanded paths per workspace via backend ui-state RPC.
 */

import { getUiValue, setUiValue, removeUiValue } from "@/lib/ui-state-client";

const STORAGE_KEY_PREFIX = "files-tree-state";
const STORAGE_VERSION = 1;

interface TreeState {
  version: number;
  expandedPaths: string[];
  lastUpdated: number;
}

function getStorageKey(workspacePath: string | null): string {
  if (!workspacePath) {
    return `${STORAGE_KEY_PREFIX}-default`;
  }
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/$/, "");
  const encoded = btoa(normalized);
  return `${STORAGE_KEY_PREFIX}-${encoded}`;
}

export function loadExpandedPaths(workspacePath: string | null): Set<string> {
  try {
    const key = getStorageKey(workspacePath);
    const parsed = getUiValue<TreeState>(key);

    if (!parsed) {
      return new Set();
    }

    if (parsed.version !== STORAGE_VERSION) {
      return new Set();
    }

    if (!Array.isArray(parsed.expandedPaths)) {
      return new Set();
    }

    return new Set(parsed.expandedPaths);
  } catch {
    return new Set();
  }
}

export function saveExpandedPaths(
  workspacePath: string | null,
  expandedPaths: Set<string>,
): void {
  try {
    const key = getStorageKey(workspacePath);
    const state: TreeState = {
      version: STORAGE_VERSION,
      expandedPaths: Array.from(expandedPaths),
      lastUpdated: Date.now(),
    };
    setUiValue(key, state);
  } catch {
    // Ignore persistence errors
  }
}

export function clearExpandedPaths(workspacePath: string | null): void {
  try {
    const key = getStorageKey(workspacePath);
    removeUiValue(key);
  } catch {
    // Ignore persistence errors
  }
}
