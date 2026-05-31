import { getUiValue, isUiStateReady, setUiValue } from "@/lib/ui-state-client";
import { create } from "zustand";

/**
 * Tracks which project nodes are expanded in the left-dock project tree.
 * Persisted through ui-state so project/chat visibility survives app reloads.
 * `knownProjectIds` lets the panel distinguish "never seen" projects from
 * projects the user explicitly collapsed.
 */
interface ProjectTreeStore {
  expanded: Set<string>;
  knownProjectIds: Set<string>;
  hydrated: boolean;
  hydrate: () => boolean;
  isExpanded: (projectId: string) => boolean;
  ensureExpanded: (projectId: string) => void;
  expand: (projectId: string) => void;
  toggle: (projectId: string) => void;
}

const STORAGE_KEY = "workspace-layout:project-tree-expanded:v1";
const STORAGE_VERSION = 1;

interface PersistedProjectTreeState {
  version: number;
  expandedProjectIds: string[];
  knownProjectIds?: string[];
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function readPersistedState(): {
  expanded: Set<string>;
  knownProjectIds: Set<string>;
} | null {
  const persisted = getUiValue<PersistedProjectTreeState>(STORAGE_KEY);
  if (!persisted || persisted.version !== STORAGE_VERSION) return null;
  if (!isStringArray(persisted.expandedProjectIds)) return null;

  const expanded = new Set(persisted.expandedProjectIds);
  const knownProjectIds = isStringArray(persisted.knownProjectIds)
    ? new Set(persisted.knownProjectIds)
    : new Set(expanded);

  for (const projectId of expanded) {
    knownProjectIds.add(projectId);
  }

  return { expanded, knownProjectIds };
}

function persistState(
  expanded: Set<string>,
  knownProjectIds: Set<string>,
): void {
  setUiValue(STORAGE_KEY, {
    version: STORAGE_VERSION,
    expandedProjectIds: Array.from(expanded),
    knownProjectIds: Array.from(knownProjectIds),
  } satisfies PersistedProjectTreeState);
}

export const useProjectTreeStore = create<ProjectTreeStore>()((set, get) => ({
  expanded: new Set<string>(),
  knownProjectIds: new Set<string>(),
  hydrated: false,
  hydrate: () => {
    const state = get();
    if (state.hydrated) return true;
    if (!isUiStateReady()) return false;

    const persisted = readPersistedState();
    const expanded = new Set(persisted?.expanded ?? []);
    const knownProjectIds = new Set(persisted?.knownProjectIds ?? []);

    // Preserve explicit expansions/collapses that happened before async
    // ui-state finished loading.
    for (const projectId of state.knownProjectIds) {
      knownProjectIds.add(projectId);
      if (state.expanded.has(projectId)) {
        expanded.add(projectId);
      } else {
        expanded.delete(projectId);
      }
    }

    set({ expanded, knownProjectIds, hydrated: true });

    if (state.knownProjectIds.size > 0) {
      persistState(expanded, knownProjectIds);
    }

    return true;
  },
  isExpanded: (projectId) => get().expanded.has(projectId),
  ensureExpanded: (projectId) => {
    set((prev) => {
      if (prev.knownProjectIds.has(projectId)) return {};
      const expanded = new Set(prev.expanded);
      const knownProjectIds = new Set(prev.knownProjectIds);
      expanded.add(projectId);
      knownProjectIds.add(projectId);
      if (prev.hydrated) persistState(expanded, knownProjectIds);
      return { expanded, knownProjectIds };
    });
  },
  expand: (projectId) => {
    set((prev) => {
      if (prev.expanded.has(projectId) && prev.knownProjectIds.has(projectId)) {
        return {};
      }
      const expanded = new Set(prev.expanded);
      const knownProjectIds = new Set(prev.knownProjectIds);
      expanded.add(projectId);
      knownProjectIds.add(projectId);
      if (prev.hydrated) persistState(expanded, knownProjectIds);
      return { expanded, knownProjectIds };
    });
  },
  toggle: (projectId) => {
    set((prev) => {
      const expanded = new Set(prev.expanded);
      const knownProjectIds = new Set(prev.knownProjectIds);
      knownProjectIds.add(projectId);
      if (expanded.has(projectId)) {
        expanded.delete(projectId);
      } else {
        expanded.add(projectId);
      }
      if (prev.hydrated) persistState(expanded, knownProjectIds);
      return { expanded, knownProjectIds };
    });
  },
}));
