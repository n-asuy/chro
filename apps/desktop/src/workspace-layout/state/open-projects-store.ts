import {
  flushUiState,
  getUiValue,
  isUiStateReady,
  setUiValue,
} from "@/lib/ui-state-client";
import { create } from "zustand";

export type OpenProjectTab = {
  id: string;
  slug: string | null;
  name: string;
  workspacePath: string | null;
};

const STORAGE_KEY = "chro.openProjectTabs";
const MAX_OPEN_PROJECTS = 30;

function readFromStorage(): OpenProjectTab[] {
  const raw = getUiValue<OpenProjectTab[]>(STORAGE_KEY);
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is OpenProjectTab =>
        Boolean(entry) &&
        typeof entry.id === "string" &&
        typeof entry.name === "string",
    )
    .slice(0, MAX_OPEN_PROJECTS);
}

function persist(entries: OpenProjectTab[]): OpenProjectTab[] {
  const trimmed = entries.slice(0, MAX_OPEN_PROJECTS);
  setUiValue(STORAGE_KEY, trimmed);
  return trimmed;
}

interface OpenProjectsStore {
  projects: OpenProjectTab[];
  hydrated: boolean;
  /**
   * Attempt to load persisted tabs from UI state and merge with anything
   * already in memory. No-op until `isUiStateReady()` returns true — callers
   * (see `useOpenProjectsSync`) poll until hydration succeeds. Merging keeps
   * any project added eagerly from the current URL before storage was ready.
   */
  hydrate: () => boolean;
  openProject: (tab: OpenProjectTab) => void;
  closeProject: (id: string) => OpenProjectTab[];
}

export const useOpenProjectsStore = create<OpenProjectsStore>()((set, get) => ({
  projects: [],
  hydrated: false,
  hydrate: () => {
    const state = get();
    if (state.hydrated) return true;
    if (!isUiStateReady()) return false;
    const stored = readFromStorage();
    const inMemory = state.projects;
    const seen = new Set(stored.map((p) => p.id));
    const extras = inMemory.filter((p) => !seen.has(p.id));
    const merged = [...stored, ...extras];
    set({ projects: merged, hydrated: true });
    if (extras.length > 0) persist(merged);
    return true;
  },
  openProject: (tab) => {
    const state = get();
    const current = state.projects;
    const index = current.findIndex((p) => p.id === tab.id);
    let next: OpenProjectTab[];
    if (index >= 0) {
      const existing = current[index];
      const merged: OpenProjectTab = {
        id: tab.id,
        slug: tab.slug ?? existing.slug,
        name: tab.name || existing.name,
        workspacePath: tab.workspacePath ?? existing.workspacePath,
      };
      if (
        merged.slug === existing.slug &&
        merged.name === existing.name &&
        merged.workspacePath === existing.workspacePath
      ) {
        return;
      }
      next = current.slice();
      next[index] = merged;
    } else {
      next = [...current, tab].slice(-MAX_OPEN_PROJECTS);
    }
    set({ projects: next });
    // Skip persistence until hydration completes — otherwise an eager write
    // from the current-URL auto-add would clobber the saved list with a
    // single-element array on every reload.
    if (state.hydrated) persist(next);
  },
  closeProject: (id) => {
    const current = get().projects;
    const next = current.filter((p) => p.id !== id);
    if (next.length === current.length) return current;
    set({ projects: next });
    persist(next);
    // Closing a tab is an explicit user action — flush immediately so a
    // quick reload doesn't restore the tab via the debounced cache.
    flushUiState();
    return next;
  },
}));
