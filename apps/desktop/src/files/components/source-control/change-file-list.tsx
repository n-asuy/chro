import { cn } from "@/lib/cn";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/** Flat list of file rows, or nested by their parent folders (VSCode-style). */
export type ChangeListViewMode = "list" | "tree";
const INITIAL_VISIBLE_FILES = 300;
const FILES_PER_PAGE = 300;

/**
 * A single changed file. `path` is repo-relative and drives folder nesting in
 * tree mode; `render` draws the row at a given indent depth so the caller keeps
 * ownership of the row's actions and badges (staging, discard, status, …).
 */
export type ChangeFileEntry = {
  path: string;
  render: (depth: number) => React.ReactNode;
};

type TreeNode =
  | { type: "dir"; key: string; name: string; children: TreeNode[] }
  | { type: "file"; key: string; entry: ChangeFileEntry };

function buildTree(entries: ChangeFileEntry[]): TreeNode[] {
  const root: Extract<TreeNode, { type: "dir" }> = {
    type: "dir",
    key: "",
    name: "",
    children: [],
  };

  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    if (segments.length === 0) segments.push(entry.path || "(unknown)");

    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const key = current.key ? `${current.key}/${segment}` : segment;

      if (i === segments.length - 1) {
        current.children.push({ type: "file", key: entry.path, entry });
        continue;
      }

      let next = current.children.find(
        (child): child is Extract<TreeNode, { type: "dir" }> =>
          child.type === "dir" && child.name === segment,
      );
      if (!next) {
        next = { type: "dir", key, name: segment, children: [] };
        current.children.push(next);
      }
      current = next;
    }
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      const aName = a.type === "dir" ? a.name : a.entry.path;
      const bName = b.type === "dir" ? b.name : b.entry.path;
      return aName.localeCompare(bName);
    });
    for (const node of nodes) if (node.type === "dir") sort(node.children);
  };
  sort(root.children);
  return compactDirs(root.children);
}

/**
 * Fold single-child directory chains into one row (VSCode "compact folders"):
 * a directory whose only child is another directory renders as `a/b/c` instead
 * of three nested rows. Keeps the deepest directory's key so collapse state is
 * stable as the chain grows.
 */
function compactDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.type !== "dir") return node;
    let name = node.name;
    let children = node.children;
    let key = node.key;
    let only = children.length === 1 ? children[0] : undefined;
    while (only && only.type === "dir") {
      name = `${name}/${only.name}`;
      key = only.key;
      children = only.children;
      only = children.length === 1 ? children[0] : undefined;
    }
    return { type: "dir", key, name, children: compactDirs(children) };
  });
}

type TreeRowsProps = {
  nodes: TreeNode[];
  depth: number;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
};

function TreeRows({ nodes, depth, collapsed, onToggle }: TreeRowsProps) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === "file") return node.entry.render(depth);

        const isCollapsed = collapsed.has(node.key);
        return (
          <div key={node.key}>
            <button
              type="button"
              onClick={() => onToggle(node.key)}
              className="flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-sm text-custom-text-200 hover:bg-custom-background-80"
              style={{ paddingLeft: 8 + depth * 12 }}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5 shrink-0 text-custom-text-300" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 text-custom-text-300" />
              )}
              <Folder className="size-3.5 shrink-0 text-custom-text-300" />
              <span className="truncate">{node.name}</span>
            </button>
            {!isCollapsed && (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/** Renders changed-file rows either flat or nested under their folders. */
export function ChangeFileList({
  entries,
  viewMode,
}: {
  entries: ChangeFileEntry[];
  viewMode: ChangeListViewMode;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_FILES);
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_FILES);
  }, [entries.length, viewMode]);
  const visibleEntries = useMemo(
    () => entries.slice(0, visibleCount),
    [entries, visibleCount],
  );
  const remaining = entries.length - visibleEntries.length;
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <>
      {viewMode === "list" ? (
        visibleEntries.map((entry) => entry.render(0))
      ) : (
        <TreeRows
          nodes={buildTree(visibleEntries)}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
        />
      )}
      {remaining > 0 && (
        <button
          type="button"
          className="mt-1 w-full rounded px-2 py-1.5 text-xs text-custom-text-300 hover:bg-custom-background-80 hover:text-custom-text-100"
          onClick={() =>
            setVisibleCount((count) =>
              Math.min(entries.length, count + FILES_PER_PAGE),
            )
          }
        >
          Show {Math.min(remaining, FILES_PER_PAGE)} more ({remaining}{" "}
          remaining)
        </button>
      )}
    </>
  );
}
