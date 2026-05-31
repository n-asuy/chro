import type { DesktopWorkspaceEntry } from "@/types/desktop";
import { FileNodeType, type FileNode } from "../types/file-tree";

const normaliseNodePath = (
  relativePath: string,
  rootPrefix: string,
): string => {
  const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned) return rootPrefix || "/";
  if (rootPrefix === "/" || rootPrefix === "") return `/${cleaned}`;
  // Ad-hoc root paths are absolute (e.g. "/Users/me/proj"); join with a
  // single slash to keep node paths unique per root.
  return `${rootPrefix.replace(/\/$/, "")}/${cleaned}`;
};

const buildMetadata = (entry: DesktopWorkspaceEntry) => {
  return {
    extension: entry.extension ?? undefined,
    modified: entry.modifiedAt ? new Date(entry.modifiedAt) : undefined,
    created: entry.createdAt ? new Date(entry.createdAt) : undefined,
    size: entry.size ?? undefined,
  } satisfies FileNode["metadata"];
};

/**
 * Convert a backend WorkspaceEntry into a FileNode for the tree.
 * Pass `rootPrefix` to scope the node paths under a non-primary
 * workspace root; defaults to the primary root convention ("/").
 */
export const entryToFileNode = (
  entry: DesktopWorkspaceEntry,
  rootPrefix = "/",
): FileNode => {
  const path = normaliseNodePath(entry.relativePath, rootPrefix);
  const base: FileNode = {
    id: `workspace:${path}`,
    name: entry.name,
    displayName: entry.displayName,
    path,
    type:
      entry.type === "directory" ? FileNodeType.Directory : FileNodeType.File,
    metadata: buildMetadata(entry),
    relativePath: entry.relativePath,
  };

  if (entry.type === "directory") {
    const children = entry.children;
    const hasRecursiveChildren = Boolean(children && children.length > 0);
    base.children =
      hasRecursiveChildren && children
        ? children.map((c) => entryToFileNode(c, rootPrefix))
        : [];
    base.hasChildren = entry.hasChildren ?? hasRecursiveChildren;
    base.isHydrated = hasRecursiveChildren;
  }

  return base;
};
