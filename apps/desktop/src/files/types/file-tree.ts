export enum FileNodeType {
  File = "file",
  Directory = "directory",
}

export type NewFileKind = "md" | "excalidraw" | "cbase";

export interface FileNode {
  id: string;
  /** Actual file name (e.g., "note.md") */
  name: string;
  /** Display name without .md extension for markdown files (e.g., "note") */
  displayName: string;
  path: string;
  type: FileNodeType;
  children?: FileNode[];
  metadata?: {
    size?: number;
    created?: Date;
    modified?: Date;
    extension?: string;
  };
  relativePath?: string;
  hasChildren?: boolean;
  isHydrated?: boolean;
  isHydrating?: boolean;
}

export interface TreeNodeProps {
  node: FileNode;
  isExpanded: boolean;
  isSelected: boolean;
  indentPx: number;
  onToggle: () => void;
  onSelect: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onOpen?: () => void;
}

const HIDDEN_EXTENSIONS = ["md", "excalidraw", "cbase"];

/**
 * Get display name — strips the extension for known file types.
 */
export const getDisplayName = (name: string, type: FileNodeType): string => {
  if (type !== FileNodeType.File) return name;
  for (const ext of HIDDEN_EXTENSIONS) {
    if (name.endsWith(`.${ext}`)) {
      return name.slice(0, -(ext.length + 1));
    }
  }
  return name;
};

/**
 * Get actual file name — appends the fallback extension only when the input has none.
 * If the user provides any extension (e.g. "doc.txt"), it is honoured as-is.
 */
export const getActualFileName = (
  displayName: string,
  type: FileNodeType,
  extension = "md",
): string => {
  if (type !== FileNodeType.File) return displayName;
  const dotIndex = displayName.lastIndexOf(".");
  if (dotIndex > 0) return displayName;
  return `${displayName}.${extension}`;
};

/**
 * Returns the initial file content for each file kind.
 */
function resolveDefaultBaseIncludePattern(parentPath: string): string {
  const normalized = parentPath
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  return normalized ? `${normalized}/**/*.md` : "**/*.md";
}

export const getInitialContent = (
  kind: NewFileKind,
  parentPath = "/",
): string => {
  switch (kind) {
    case "md":
      return "";
    case "excalidraw":
      return JSON.stringify(
        {
          type: "excalidraw",
          version: 2,
          source: "chro",
          elements: [],
          appState: {
            viewBackgroundColor: "#ffffff",
            gridSize: null,
          },
          files: {},
          fileRefs: {},
        },
        null,
        2,
      );
    case "cbase": {
      const includePattern = resolveDefaultBaseIncludePattern(parentPath);
      return `${[
        "version: 1",
        'name: "Untitled"',
        "dataset:",
        `  include: ["${includePattern}"]`,
        "properties:",
        "  title:",
        '    key: "title"',
        '    type: "text"',
        "views:",
        "  - id: default",
        '    name: "All"',
        '    type: "table"',
        "    default: true",
      ].join("\n")}\n`;
    }
  }
};

/**
 * Recursively find a node by its path in the file tree.
 */
export const findNodeByPath = (
  nodes: FileNode[],
  targetPath: string,
): FileNode | null => {
  for (const node of nodes) {
    if (node.path === targetPath) return node;
    if (node.children?.length) {
      const found = findNodeByPath(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
};
