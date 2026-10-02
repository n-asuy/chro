/**
 * The directory map: a project's main checkout as a tree of directories and
 * files, keyed by repo-relative path (`""` is the root, never rendered as a
 * row of its own). Built from the flat, gitignore-filtered listing the server
 * returns, ordered according to the sidebar's sort choice.
 */

export interface DirectoryTreeEntry {
  /** Repo-relative path with forward slashes, no leading or trailing slash. */
  path: string;
  isFile: boolean;
}

export interface DirectoryTreeNode {
  path: string;
  name: string;
  isFile: boolean;
  /** Directories first, then files, each group in the chosen order. */
  children: DirectoryTreeNode[];
}

export type DirectoryMapSortMode = "name-asc" | "name-desc" | "recent";

/** Recent activity rolls up from sessions into each ancestor directory. */
export function directoryLastActivity(
  tasks: readonly { home_dir?: string | null; updated_at: string }[],
): ReadonlyMap<string, number> {
  const latest = new Map<string, number>();
  for (const task of tasks) {
    if (task.home_dir == null) continue;
    const at = Date.parse(task.updated_at);
    if (!Number.isFinite(at)) continue;
    for (const dir of ancestorDirectories(task.home_dir)) {
      latest.set(dir, Math.max(latest.get(dir) ?? 0, at));
    }
  }
  return latest;
}

/**
 * Nest a flat listing into a tree rooted at `""`. Parent directories missing
 * from the listing are synthesized so no entry is orphaned.
 */
export function buildDirectoryTree(
  entries: readonly DirectoryTreeEntry[],
  sortMode: DirectoryMapSortMode = "name-asc",
  lastActivity: ReadonlyMap<string, number> = new Map(),
): DirectoryTreeNode {
  const root: DirectoryTreeNode = {
    path: "",
    name: "",
    isFile: false,
    children: [],
  };
  const byPath = new Map<string, DirectoryTreeNode>([["", root]]);

  const ensureDirectory = (path: string): DirectoryTreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const parent = ensureDirectory(parentDirectory(path));
    const node: DirectoryTreeNode = {
      path,
      name: baseName(path),
      isFile: false,
      children: [],
    };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    if (!path) continue;
    if (entry.isFile) {
      const parent = ensureDirectory(parentDirectory(path));
      parent.children.push({
        path,
        name: baseName(path),
        isFile: true,
        children: [],
      });
    } else {
      ensureDirectory(path);
    }
  }

  sortChildren(root, sortMode, lastActivity);
  return root;
}

function sortChildren(
  node: DirectoryTreeNode,
  mode: DirectoryMapSortMode,
  lastActivity: ReadonlyMap<string, number>,
): void {
  node.children.sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    if (mode === "recent") {
      const diff =
        (lastActivity.get(b.path) ?? 0) - (lastActivity.get(a.path) ?? 0);
      if (diff !== 0) return diff;
    }
    const cmp = a.name.localeCompare(b.name);
    return mode === "name-desc" ? -cmp : cmp;
  });
  for (const child of node.children) sortChildren(child, mode, lastActivity);
}

function normalizePath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Directory containing `path`; `""` for a top-level entry or the root. */
export function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Every directory from the root down to and including `path`, in order. */
export function ancestorDirectories(path: string): string[] {
  const chain: string[] = [""];
  if (!path) return chain;
  let current = "";
  for (const segment of path.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    chain.push(current);
  }
  return chain;
}
