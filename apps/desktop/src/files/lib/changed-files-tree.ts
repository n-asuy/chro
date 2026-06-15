/**
 * Builds a file tree containing ONLY changed files, for the session sandbox
 * view. Unlike the full worktree listing, this is session-scoped: when you look
 * at a task run you see just what the agent touched, nested under their folders.
 *
 * The session tree is intentionally undecorated (no diff colors/badges) — that
 * review belongs to the branch-scoped Source Control panel — so only the paths
 * are needed here. Produced nodes use the primary-root convention
 * `path = "/" + relativePath`.
 */
import { type FileNode, FileNodeType } from "../types/file-tree";

interface MutableDir extends FileNode {
  children: FileNode[];
}

/**
 * Build a nested `FileNode[]` from a flat list of changed file paths
 * (repo-relative). Directories are synthesized for every path segment and
 * marked fully hydrated (the change set is complete, so the tree never
 * lazy-loads).
 */
export function buildChangedFilesTree(paths: string[]): FileNode[] {
  const rootChildren: FileNode[] = [];
  const dirByPath = new Map<string, MutableDir>();

  const childrenOf = (relPath: string): FileNode[] => {
    if (relPath === "") return rootChildren;
    const existing = dirByPath.get(relPath);
    if (existing) return existing.children;

    const segments = relPath.split("/");
    const name = segments[segments.length - 1]!;
    const parentChildren = childrenOf(segments.slice(0, -1).join("/"));
    const dir: MutableDir = {
      id: `changed-dir:${relPath}`,
      name,
      displayName: name,
      path: `/${relPath}`,
      type: FileNodeType.Directory,
      relativePath: relPath,
      children: [],
      hasChildren: true,
      isHydrated: true,
    };
    parentChildren.push(dir);
    dirByPath.set(relPath, dir);
    return dir.children;
  };

  const seen = new Set<string>();
  for (const rawPath of paths) {
    const rel = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);

    const segments = rel.split("/");
    const name = segments[segments.length - 1]!;
    const parentChildren = childrenOf(segments.slice(0, -1).join("/"));
    parentChildren.push({
      id: `changed-file:${rel}`,
      name,
      displayName: name,
      path: `/${rel}`,
      type: FileNodeType.File,
      relativePath: rel,
    });
  }

  sortTree(rootChildren);
  return rootChildren;
}

/** Directories before files, then alphabetical — applied recursively. */
function sortTree(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    const aDir = a.type === FileNodeType.Directory;
    const bDir = b.type === FileNodeType.Directory;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.children) sortTree(node.children);
  }
}

/** Collect the `path` of every directory node — used to expand-all on load. */
export function collectDirectoryPaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === FileNodeType.Directory) {
        paths.push(node.path);
        if (node.children) walk(node.children);
      }
    }
  };
  walk(nodes);
  return paths;
}
