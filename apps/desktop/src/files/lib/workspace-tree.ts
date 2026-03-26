import type { DesktopWorkspaceEntry } from "@/types/desktop";
import { FileNodeType, type FileNode } from "../types/file-tree";

const normaliseNodePath = (relativePath: string): string => {
  if (!relativePath) return "/";
  const cleaned = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return `/${cleaned}`;
};

const buildMetadata = (entry: DesktopWorkspaceEntry) => {
  return {
    extension: entry.extension ?? undefined,
    modified: entry.modifiedAt ? new Date(entry.modifiedAt) : undefined,
    created: entry.createdAt ? new Date(entry.createdAt) : undefined,
    size: entry.size ?? undefined,
  } satisfies FileNode["metadata"];
};

export const entryToFileNode = (entry: DesktopWorkspaceEntry): FileNode => {
  const path = normaliseNodePath(entry.relativePath);
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
    // Recursively convert children if present (from recursive API call)
    const children = entry.children;
    const hasRecursiveChildren = Boolean(children && children.length > 0);
    base.children =
      hasRecursiveChildren && children ? children.map(entryToFileNode) : [];
    base.hasChildren = entry.hasChildren ?? hasRecursiveChildren;
    // Mark as hydrated if we have the children data
    base.isHydrated = hasRecursiveChildren;
  }

  return base;
};
