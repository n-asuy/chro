import { create } from "zustand";
import { ancestorDirectories } from "../domain/directory-tree";

interface MapProjectState {
  /** The project's section lists its directory tree instead of its sessions. */
  showsFiles: boolean;
  expanded: ReadonlySet<string>;
  revealed: ReadonlySet<string>;
}

/**
 * Projects start on their sessions. Switching one to files is what loads its
 * tree, so the cost of the panel scales with the projects the user is
 * browsing, not with every project the workspace has.
 */
export const EMPTY_MAP_PROJECT: MapProjectState = {
  showsFiles: false,
  expanded: new Set(),
  revealed: new Set(),
};

interface DirectoryMapStore {
  projects: Record<string, MapProjectState>;
  toggleFiles: (projectId: string) => void;
  toggleDirectory: (projectId: string, path: string) => void;
  revealHomedDirectories: (projectId: string, paths: readonly string[]) => void;
  /**
   * Open the tree down to `path` (null: nothing to open), adding to what is
   * already open. Used to show where the focused session lives.
   */
  revealDirectory: (projectId: string, path: string | null) => void;
}

/** Browsing state survives switching a project between sessions and files. */
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
    toggleFiles: (id) =>
      update(id, (project) => ({
        ...project,
        showsFiles: !project.showsFiles,
      })),
    toggleDirectory: (id, path) =>
      update(id, (project) => {
        const expanded = new Set(project.expanded);
        if (expanded.has(path)) expanded.delete(path);
        else expanded.add(path);
        return { ...project, expanded };
      }),
    revealDirectory: (id, path) =>
      update(id, (project) => {
        const missing =
          path === null
            ? []
            : ancestorDirectories(path).filter(
                (dir) => !project.expanded.has(dir),
              );
        if (missing.length === 0) return project;
        return {
          ...project,
          expanded: new Set([...project.expanded, ...missing]),
        };
      }),
    revealHomedDirectories: (id, paths) =>
      update(id, (project) => {
        const fresh = paths.filter((path) => !project.revealed.has(path));
        if (fresh.length === 0) return project;
        const expanded = new Set(project.expanded);
        if (project.showsFiles) {
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
