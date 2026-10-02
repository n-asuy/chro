import { create } from "zustand";
import { ancestorDirectories } from "../domain/directory-tree";

interface MapProjectState {
  collapsed: boolean;
  expanded: ReadonlySet<string>;
  revealed: ReadonlySet<string>;
}

/**
 * Projects start folded. Opening one is what loads its tree, so the cost of
 * the panel scales with the projects the user is browsing, not with every
 * project the workspace has.
 */
export const EMPTY_MAP_PROJECT: MapProjectState = {
  collapsed: true,
  expanded: new Set(),
  revealed: new Set(),
};

interface DirectoryMapStore {
  projects: Record<string, MapProjectState>;
  toggleProject: (projectId: string) => void;
  toggleDirectory: (projectId: string, path: string) => void;
  collapseAll: (projectIds: readonly string[]) => void;
  revealHomedDirectories: (projectId: string, paths: readonly string[]) => void;
}

/** Browsing state survives Inbox/Map switches, like Inbox's project folding. */
export const useDirectoryMapStore = create<DirectoryMapStore>()((set) => {
  const update = (
    projectId: string,
    apply: (project: MapProjectState) => MapProjectState,
  ) =>
    set((state) => {
      const previous = state.projects[projectId] ?? EMPTY_MAP_PROJECT;
      const project = apply(previous);
      return project === previous
        ? state
        : { projects: { ...state.projects, [projectId]: project } };
    });

  return {
    projects: {},
    toggleProject: (id) =>
      update(id, (project) => ({ ...project, collapsed: !project.collapsed })),
    toggleDirectory: (id, path) =>
      update(id, (project) => {
        const expanded = new Set(project.expanded);
        if (expanded.has(path)) expanded.delete(path);
        else expanded.add(path);
        return { ...project, expanded };
      }),
    collapseAll: (ids) =>
      set((state) => {
        const projects = { ...state.projects };
        for (const id of ids) {
          projects[id] = {
            ...(projects[id] ?? EMPTY_MAP_PROJECT),
            collapsed: true,
            expanded: new Set(),
          };
        }
        return { projects };
      }),
    revealHomedDirectories: (id, paths) =>
      update(id, (project) => {
        const fresh = paths.filter((path) => !project.revealed.has(path));
        if (fresh.length === 0) return project;
        const expanded = new Set(project.expanded);
        if (!project.collapsed) {
          for (const path of fresh) {
            for (const dir of ancestorDirectories(path)) expanded.add(dir);
          }
        }
        return {
          ...project,
          expanded,
          revealed: new Set([...project.revealed, ...fresh]),
        };
      }),
  };
});
