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
  isFocused: boolean;
  indentPx: number;
  onToggle: () => void;
  onSelect: (event: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onOpen?: () => void;
}

/**
 * Extensions chro renders as documents, whose extension is therefore hidden.
 * Mirrors `DOCUMENT_EXTENSIONS` in the Rust `document::name` module — the
 * server sends `displayName` with entries it lists, and this computes the
 * same name for nodes the client creates locally, so a file does not change
 * its name depending on which side produced the node.
 */
const DOCUMENT_EXTENSIONS = ["md", "markdown", "excalidraw", "cbase"];

/**
 * The name a file is shown under: without the extension when chro renders
 * that format as a document, unchanged otherwise (the extension of `main.rs`
 * is information, not noise). Directories never hide anything.
 */
export const getDisplayName = (name: string, type: FileNodeType): string => {
  if (type !== FileNodeType.File) return name;
  const dotIndex = name.lastIndexOf(".");
  // A leading dot is not an extension separator: `.gitignore` is a name.
  if (dotIndex <= 0) return name;
  const extension = name.slice(dotIndex + 1).toLowerCase();
  return DOCUMENT_EXTENSIONS.includes(extension) ? name.slice(0, dotIndex) : name;
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
