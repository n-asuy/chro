import { FolderPickerDialog } from "@/components/dialogs/folder-picker-dialog";
import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { revealInFinder } from "@/lib/project-client";
import { usePromptEditorHandle } from "@/session/hooks/use-prompt-editor";
import { useLayoutStore } from "@/workspace-layout/state/layout-store";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@chro/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Database,
  ExternalLink,
  FilePlus,
  FileText,
  FolderInput,
  FolderPlus,
  Images,
  Minimize2,
  PanelLeftClose,
  PenLine,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useProjectContext } from "../../context/project-context";
import { useDecoratedTree } from "../../hooks/use-decorated-tree";
import { useFileTreeDnd } from "../../hooks/use-file-tree-dnd";
import { useFileTreeExternalDrop } from "../../hooks/use-file-tree-external-drop";
import {
  getContextSelectionPaths,
  getObsidianPointerSelectionMode,
  getVisibleRangePaths,
  normalizeFileOperationPaths,
} from "../../lib/file-tree-selection";
import { EMPTY_DECORATIONS } from "../../lib/git-status-decoration";
import { useFileTreeStore } from "../../state/file-tree-store";
import { type WorktreeScopeView, useFilesStore } from "../../state/files-store";
import type { FileNode } from "../../types/file-tree";
import {
  FileNodeType,
  type NewFileKind,
  findNodeByPath,
  getActualFileName,
  getInitialContent,
} from "../../types/file-tree";
import { MoveSelectionDialog } from "./move-selection-dialog";
import { TreeContextMenu } from "./tree-context-menu";
import { TreeNode } from "./tree-node";

const TREE_INDENT_BASE = 18;
const TREE_INDENT_STEP = 16;
const ROOT_INDENT_PX = 4;
const ROW_HEIGHT = 28;
const VIRTUALIZER_OVERSCAN = 8;

interface VisibleRow {
  node: FileNode;
  depth: number;
  isExpanded: boolean;
  indentPx: number;
  isWorkspaceRoot: boolean;
}

type FileTreeProps = {
  onClose?: () => void;
};

export const FileTree = ({ onClose }: FileTreeProps) => {
  const { t } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollVisibilityTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [showScrollBar, setShowScrollBar] = useState(false);
  const { projectId, workspacePath } = useProjectContext();

  const {
    fileTree,
    rootPath,
    roots,
    selectedPaths,
    revealRequest,
    scopeTaskRunId,
    selectNode,
    selectNodes,
    clearSelection,
    createFile,
    createFolder,
    deleteNodes,
    duplicateNode,
    openFile,
    startEditing,
    moveNodes,
    importExternalFiles,
    editingPath,
    addRoot,
    removeRoot,
    worktreeScopeView,
    setWorktreeScopeView,
  } = useFilesStore();
  const openTab = useLayoutStore((s) => s.openTab);

  // A session sandbox (task-run worktree) is read-only here: it lists and
  // opens files, but project-scoped mutations are hidden/disabled.
  const isWorktreeScope = scopeTaskRunId != null;

  // Worktree-only range switch: how much of the tree to list. The data swap
  // lives in the dock panel, which reacts to `worktreeScopeView`; this just sets
  // the mode.
  const worktreeScopeOptions: { value: WorktreeScopeView; label: string }[] = [
    { value: "changed", label: t("worktreeChangedFiles") },
    { value: "all", label: t("worktreeAllFiles") },
  ];

  // Git status decorations: tint + badge changed files and roll the status up to
  // ancestor folders. Computed by the backend (`decorated-tree` endpoint) and
  // rendered directly. Only in local/project mode — in a worktree session the
  // tree stays plain (no diff colors); that change review lives in the
  // branch-scoped Source Control panel. The right dock shows one panel at a
  // time, so this poller does not overlap with the source-control panel's.
  const { decorations: serverDecorations } = useDecoratedTree({
    projectId,
    enabled: !isWorktreeScope,
  });
  const decorations = isWorktreeScope ? EMPTY_DECORATIONS : serverDecorations;

  const deriveAdHocRootName = useCallback((absolutePath: string): string => {
    const trimmed = absolutePath.replace(/[\\/]+$/, "");
    const segments = trimmed.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? absolutePath;
  }, []);

  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveDialogPaths, setMoveDialogPaths] = useState<string[]>([]);

  const handleAddFolderToProject = useCallback(() => {
    setFolderPickerOpen(true);
  }, []);

  const handleFolderPickerSelect = useCallback(
    (picked: string | null) => {
      if (!picked) return;
      const name = deriveAdHocRootName(picked);
      addRoot({
        path: picked,
        name,
        displayName: name,
        isPrimary: false,
        children: [],
      });
    },
    [addRoot, deriveAdHocRootName],
  );

  const handleRemoveFolderFromProject = useCallback(
    (path: string) => {
      removeRoot(path);
    },
    [removeRoot],
  );

  const handleMoveRequest = useCallback((paths: string[]) => {
    const operationPaths = normalizeFileOperationPaths(paths);
    if (operationPaths.length === 0) return;
    setMoveDialogPaths(operationPaths);
    setMoveDialogOpen(true);
  }, []);

  const handleMoveSelection = useCallback(
    async (targetParentPath: string) => {
      await moveNodes(moveDialogPaths, targetParentPath);
    },
    [moveDialogPaths, moveNodes],
  );

  // Prompt editor handle (singleton, shared with the chat input).
  // Methods are no-ops when the editor is not mounted.
  const promptEditorHandle = usePromptEditorHandle();

  const handleDropToPromptEditor = useCallback(
    ({
      nodes,
      clientX,
      clientY,
    }: {
      nodes: { path: string; name: string; isDir: boolean }[];
      clientX: number;
      clientY: number;
    }) => {
      if (!promptEditorHandle.editorRef.current) return;
      promptEditorHandle.setCursorFromPoint(clientX, clientY);
      for (const node of nodes) {
        promptEditorHandle.addFilePart(node.path, !node.isDir);
      }
    },
    [promptEditorHandle],
  );

  const selectedDragNodes = useMemo(() => {
    const operationPaths = normalizeFileOperationPaths(selectedPaths);
    return operationPaths.flatMap((path) => {
      const node = findNodeByPath(fileTree, path);
      return node ? [node] : [];
    });
  }, [fileTree, selectedPaths]);

  const { expandedPaths, toggleFolderWithHydration, collapseAll } =
    useFileTreeStore();
  const handleHoverDirectory = useCallback(
    (path: string) => {
      if (useFileTreeStore.getState().expandedPaths.has(path)) return;
      void toggleFolderWithHydration(path);
    },
    [toggleFolderWithHydration],
  );

  // Internal DnD hook (tree-to-tree moves + drop to chat input)
  const { dragState, handlers: dndHandlers } = useFileTreeDnd({
    rootPath,
    selectedNodes: selectedDragNodes,
    onMove: moveNodes,
    onDropToPromptEditor: handleDropToPromptEditor,
    onHoverDirectory: handleHoverDirectory,
  });

  // External drop hook (files from OS). Disabled in worktree scope so OS file
  // drops cannot import into the project checkout while a sandbox is shown.
  const { dropState: externalDropState } = useFileTreeExternalDrop({
    rootPath,
    enabled: !isWorktreeScope,
    onDrop: importExternalFiles,
  });

  // When a folder expands, fade its freshly-revealed descendant rows in (see
  // `.tree-row-reveal`). This is derived DURING render — not in an effect — so
  // the new rows already carry the class on their first mount. Doing it in an
  // effect applies the class a frame late, after the rows have already painted,
  // so they just pop in (the bug this replaces). The window is cleared a beat
  // later so scrolling never re-triggers the animation.
  const [prevExpanded, setPrevExpanded] = useState(expandedPaths);
  const [justExpanded, setJustExpanded] = useState<{
    path: string;
    token: number;
  } | null>(null);
  if (prevExpanded !== expandedPaths) {
    if (expandedPaths.size > prevExpanded.size) {
      let added: string | null = null;
      for (const candidate of expandedPaths) {
        if (!prevExpanded.has(candidate)) {
          added = candidate;
          break;
        }
      }
      if (added) {
        const path = added;
        setJustExpanded((current) => ({
          path,
          token: (current?.token ?? 0) + 1,
        }));
      }
    }
    setPrevExpanded(expandedPaths);
  }
  useEffect(() => {
    if (!justExpanded) return;
    const { token } = justExpanded;
    const timer = setTimeout(() => {
      setJustExpanded((current) => (current?.token === token ? null : current));
    }, 400);
    return () => clearTimeout(timer);
  }, [justExpanded]);

  // Compute visible rows from the current expansion state.
  // Each WorkspaceRoot contributes a synthetic header row labeled with its
  // directory name (Zed-style worktree). The project's file nodes nest one
  // level beneath their root and are only walked when the root is expanded.
  // Root rows sit flush left; nested rows start at TREE_INDENT_BASE so the
  // chevron column is aligned regardless of nesting depth.
  const visibleRows = useMemo(() => {
    const rows: VisibleRow[] = [];

    const walk = (nodes: FileNode[], depth: number) => {
      for (const node of nodes) {
        const isDirectory = node.type === FileNodeType.Directory;
        const isExpanded = isDirectory && expandedPaths.has(node.path);
        const indentPx =
          TREE_INDENT_BASE + Math.max(0, depth - 1) * TREE_INDENT_STEP;

        rows.push({
          node,
          depth,
          isExpanded,
          indentPx,
          isWorkspaceRoot: false,
        });

        if (isDirectory && isExpanded && node.children?.length) {
          walk(node.children, depth + 1);
        }
      }
    };

    if (roots.length === 0) {
      walk(fileTree, 1);
      return rows;
    }

    for (const root of roots) {
      const isRootExpanded = expandedPaths.has(root.path);
      const rootChildren = root.isPrimary ? fileTree : root.children ?? [];
      const rootNode: FileNode = {
        id: `workspace-root:${root.path}`,
        name: root.name,
        displayName: root.displayName,
        path: root.path,
        type: FileNodeType.Directory,
        relativePath: "",
        children: rootChildren,
        hasChildren: rootChildren.length > 0,
        isHydrated: true,
      };
      rows.push({
        node: rootNode,
        depth: 0,
        isExpanded: isRootExpanded,
        indentPx: ROOT_INDENT_PX,
        isWorkspaceRoot: true,
      });
      if (isRootExpanded) {
        walk(rootChildren, 1);
      }
    }

    return rows;
  }, [fileTree, roots, expandedPaths]);

  // Configure row virtualization for the current tree view.
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    estimateSize: () => ROW_HEIGHT,
    getScrollElement: () => containerRef.current,
    overscan: VIRTUALIZER_OVERSCAN,
  });

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const workspaceRootPathSet = useMemo(
    () => new Set(roots.map((root) => root.path)),
    [roots],
  );
  const selectableVisiblePaths = useMemo(
    () =>
      visibleRows
        .filter((row) => !row.isWorkspaceRoot)
        .map((row) => row.node.path),
    [visibleRows],
  );
  const selectionAnchorRef = useRef<string | null>(null);
  const [keyboardFocusPath, setKeyboardFocusPath] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (
      keyboardFocusPath &&
      visibleRows.some((row) => row.node.path === keyboardFocusPath)
    ) {
      return;
    }
    const fallback =
      [...selectedPaths]
        .reverse()
        .find((path) => selectableVisiblePaths.includes(path)) ?? null;
    setKeyboardFocusPath(fallback);
    if (!fallback) selectionAnchorRef.current = null;
  }, [keyboardFocusPath, selectableVisiblePaths, selectedPaths, visibleRows]);

  const replaceSelection = useCallback(
    (path: string) => {
      selectNode(path);
      selectionAnchorRef.current = path;
      setKeyboardFocusPath(path);
    },
    [selectNode],
  );

  const extendSelection = useCallback(
    (targetPath: string) => {
      const fallbackAnchor =
        selectionAnchorRef.current ??
        keyboardFocusPath ??
        selectedPaths[selectedPaths.length - 1] ??
        targetPath;
      const anchorPath = selectableVisiblePaths.includes(fallbackAnchor)
        ? fallbackAnchor
        : targetPath;
      selectNodes(
        getVisibleRangePaths(selectableVisiblePaths, anchorPath, targetPath),
      );
      selectionAnchorRef.current = anchorPath;
      setKeyboardFocusPath(targetPath);
    },
    [keyboardFocusPath, selectNodes, selectedPaths, selectableVisiblePaths],
  );

  const handleNodeSelect = useCallback(
    (event: React.MouseEvent, path: string, isWorkspaceRoot: boolean) => {
      const mode = getObsidianPointerSelectionMode({
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        primaryModifierKey: event.ctrlKey || event.metaKey,
      });
      if (isWorkspaceRoot) {
        if (mode === "replace") replaceSelection(path);
        else setKeyboardFocusPath(path);
        return;
      }
      if (mode === "range") {
        extendSelection(path);
        return;
      }
      if (mode === "toggle") {
        selectNode(path, true);
        selectionAnchorRef.current = path;
        setKeyboardFocusPath(path);
        return;
      }
      if (mode === "preserve") {
        selectionAnchorRef.current = path;
        setKeyboardFocusPath(path);
        return;
      }
      replaceSelection(path);
    },
    [extendSelection, replaceSelection, selectNode],
  );

  const handleNodeContextMenu = useCallback(
    (path: string) => {
      setKeyboardFocusPath(path);
      if (selectedSet.has(path)) return;
      replaceSelection(path);
    },
    [replaceSelection, selectedSet],
  );

  const findNode = useCallback(
    (targetPath: string | null): FileNode | null => {
      if (!targetPath) return null;
      return findNodeByPath(fileTree, targetPath);
    },
    [fileTree],
  );

  const resolveParentPath = useCallback(
    (path: string | null) => {
      if (!path) return rootPath ?? "/";
      const targetNode = findNode(path);
      if (targetNode?.type === FileNodeType.Directory) {
        return targetNode.path;
      }

      const segments = path.split("/").filter(Boolean);
      if (segments.length <= 1) {
        return rootPath ?? "/";
      }
      return `/${segments.slice(0, -1).join("/")}`;
    },
    [findNode, rootPath],
  );

  const handleDelete = useCallback(
    (paths: string[]) => {
      deleteNodes(paths).catch((error) => {
        console.error("[file-tree] Delete operation failed:", error);
      });
    },
    [deleteNodes],
  );

  const handleRename = useCallback(
    (path: string, _name: string) => {
      const node = findNode(path);
      startEditing(path, node?.name ?? _name);
    },
    [findNode, startEditing],
  );

  const handleDuplicate = useCallback(
    (path: string) => {
      duplicateNode(path).catch((error) => {
        console.error("[file-tree] Duplicate operation failed:", error);
      });
    },
    [duplicateNode],
  );

  const handleRevealRootInFinder = useCallback(() => {
    if (!projectId) return;
    revealInFinder(projectId, "/").catch((err) => {
      console.warn("[file-tree] Failed to reveal project root in finder:", err);
    });
  }, [projectId]);

  const getChildrenForParent = useCallback(
    (parentPath: string) => {
      if (!parentPath || parentPath === "/") {
        return fileTree;
      }
      const parentNode = findNode(parentPath);
      return parentNode?.children ?? [];
    },
    [fileTree, findNode],
  );

  const getDefaultName = useCallback(
    (parentPath: string, type: FileNodeType, extension = "md") => {
      const siblings = getChildrenForParent(parentPath) ?? [];
      const baseName =
        type === FileNodeType.File
          ? extension === "excalidraw"
            ? "New drawing"
            : extension === "cbase"
              ? "New database"
              : "New file"
          : "New folder";
      const siblingNames = siblings.map((child) => child.name);

      let counter = 1;
      let candidateDisplay = baseName;
      let candidateActual = getActualFileName(baseName, type, extension);
      while (siblingNames.includes(candidateActual)) {
        counter += 1;
        candidateDisplay = `${baseName} ${counter}`;
        candidateActual = getActualFileName(candidateDisplay, type, extension);
      }
      return candidateDisplay;
    },
    [getChildrenForParent],
  );

  const quickCreate = useCallback(
    async (
      type: FileNodeType,
      explicitParentPath?: string,
      fileKind: NewFileKind = "md",
    ) => {
      const fallbackParent =
        resolveParentPath(selectedPaths[selectedPaths.length - 1] ?? null) ??
        "/";
      const parentPath = explicitParentPath ?? fallbackParent;
      const extension = type === FileNodeType.File ? fileKind : "md";
      const name = getDefaultName(parentPath, type, extension);

      try {
        if (type === FileNodeType.File) {
          const initialContent = getInitialContent(fileKind, parentPath);
          await createFile(parentPath, name, fileKind, initialContent);
        } else {
          await createFolder(parentPath, name);
        }
      } catch (error) {
        console.error("[file-tree] quickCreate failed:", error);
      }
    },
    [
      resolveParentPath,
      selectedPaths,
      getDefaultName,
      createFile,
      createFolder,
    ],
  );

  const hasTree = fileTree.length > 0;
  const rootTargetPath = rootPath ?? "/";

  // Scroll to editing node when editing starts (for new file/folder creation)
  useEffect(() => {
    if (!editingPath) return;
    const index = visibleRows.findIndex((r) => r.node.path === editingPath);
    if (index >= 0) {
      rowVirtualizer.scrollToIndex(index, { align: "center" });
    }
  }, [editingPath, visibleRows, rowVirtualizer]);

  // Scroll a reveal target (e.g. a skill folder focused from the Skills panel)
  // into view. The panel expands + hydrates ancestors asynchronously, so this
  // re-runs as visibleRows grows and fires once the row appears. The token
  // guard scrolls a given request exactly once so manual scrolling afterward is
  // not yanked back.
  const handledRevealTokenRef = useRef(0);
  useEffect(() => {
    if (!revealRequest) return;
    if (revealRequest.token === handledRevealTokenRef.current) return;
    const index = visibleRows.findIndex(
      (r) => r.node.path === revealRequest.path,
    );
    if (index < 0) return;
    handledRevealTokenRef.current = revealRequest.token;
    rowVirtualizer.scrollToIndex(index, { align: "center" });
  }, [revealRequest, visibleRows, rowVirtualizer]);

  useEffect(() => {
    return () => {
      if (scrollVisibilityTimeoutRef.current) {
        clearTimeout(scrollVisibilityTimeoutRef.current);
      }
    };
  }, []);

  const handleTreeScroll = useCallback(() => {
    setShowScrollBar(true);

    if (scrollVisibilityTimeoutRef.current) {
      clearTimeout(scrollVisibilityTimeoutRef.current);
    }

    scrollVisibilityTimeoutRef.current = setTimeout(() => {
      setShowScrollBar(false);
      scrollVisibilityTimeoutRef.current = null;
    }, 600);
  }, []);

  // Handle keyboard navigation for the tree view.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (e.target as HTMLElement).isContentEditable
      ) {
        return;
      }

      const currentPath =
        keyboardFocusPath ?? selectedPaths[selectedPaths.length - 1];
      const currentIndex = visibleRows.findIndex(
        (r) => r.node.path === currentPath,
      );
      const current =
        currentIndex >= 0 ? visibleRows[currentIndex]?.node : null;
      const isDir = current?.type === FileNodeType.Directory;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next =
            currentIndex === -1
              ? 0
              : Math.min(visibleRows.length - 1, currentIndex + 1);
          const nextRow = visibleRows[next];
          if (nextRow) {
            if (e.shiftKey && !nextRow.isWorkspaceRoot) {
              extendSelection(nextRow.node.path);
            } else {
              selectionAnchorRef.current = nextRow.node.path;
              setKeyboardFocusPath(nextRow.node.path);
            }
            if (
              (e.metaKey || e.ctrlKey) &&
              nextRow.node.type === FileNodeType.File
            ) {
              openFile(nextRow.node.path, scopeTaskRunId ?? undefined);
            }
            rowVirtualizer.scrollToIndex(next);
          }
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev = currentIndex === -1 ? 0 : Math.max(0, currentIndex - 1);
          const prevRow = visibleRows[prev];
          if (prevRow) {
            if (e.shiftKey && !prevRow.isWorkspaceRoot) {
              extendSelection(prevRow.node.path);
            } else {
              selectionAnchorRef.current = prevRow.node.path;
              setKeyboardFocusPath(prevRow.node.path);
            }
            if (
              (e.metaKey || e.ctrlKey) &&
              prevRow.node.type === FileNodeType.File
            ) {
              openFile(prevRow.node.path, scopeTaskRunId ?? undefined);
            }
            rowVirtualizer.scrollToIndex(prev);
          }
          break;
        }
        case "Home": {
          e.preventDefault();
          if (visibleRows[0]) {
            const firstRow = visibleRows[0];
            if (e.shiftKey && !firstRow.isWorkspaceRoot) {
              extendSelection(firstRow.node.path);
            } else {
              selectionAnchorRef.current = firstRow.node.path;
              setKeyboardFocusPath(firstRow.node.path);
            }
            rowVirtualizer.scrollToIndex(0);
          }
          break;
        }
        case "End": {
          e.preventDefault();
          if (visibleRows.length) {
            const last = visibleRows.length - 1;
            const lastRow = visibleRows[last];
            if (e.shiftKey && !lastRow.isWorkspaceRoot) {
              extendSelection(lastRow.node.path);
            } else {
              selectionAnchorRef.current = lastRow.node.path;
              setKeyboardFocusPath(lastRow.node.path);
            }
            rowVirtualizer.scrollToIndex(last);
          }
          break;
        }
        case "ArrowRight": {
          if (!current) break;
          e.preventDefault();
          if (isDir) {
            const expanded = expandedPaths.has(current.path);
            if (!expanded) {
              void toggleFolderWithHydration(current.path);
            } else {
              const child = visibleRows[currentIndex + 1];
              if (
                child &&
                currentIndex >= 0 &&
                child.depth === visibleRows[currentIndex].depth + 1
              ) {
                selectionAnchorRef.current = child.node.path;
                setKeyboardFocusPath(child.node.path);
                rowVirtualizer.scrollToIndex(currentIndex + 1);
              }
            }
          }
          break;
        }
        case "ArrowLeft": {
          if (!current) break;
          e.preventDefault();
          if (isDir && expandedPaths.has(current.path)) {
            void toggleFolderWithHydration(current.path);
          } else {
            const parentPath =
              current.path.split("/").slice(0, -1).join("/") || "/";
            const parentIdx = visibleRows.findIndex(
              (r) => r.node.path === parentPath,
            );
            if (parentIdx >= 0) {
              selectionAnchorRef.current = parentPath;
              setKeyboardFocusPath(parentPath);
              rowVirtualizer.scrollToIndex(parentIdx);
            }
          }
          break;
        }
        case "Enter": {
          if (!current) break;
          e.preventDefault();
          replaceSelection(current.path);
          if (isDir) {
            void toggleFolderWithHydration(current.path);
          } else {
            openFile(current.path, scopeTaskRunId ?? undefined);
          }
          break;
        }
      }
    },
    [
      selectedPaths,
      keyboardFocusPath,
      visibleRows,
      expandedPaths,
      extendSelection,
      replaceSelection,
      toggleFolderWithHydration,
      openFile,
      rowVirtualizer,
    ],
  );

  const handleMouseDownCapture = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      containerRef.current?.focus({ preventScroll: true });
    },
    [containerRef],
  );

  const handleTreeClick = useCallback(
    (e: React.MouseEvent) => {
      containerRef.current?.focus({ preventScroll: true });

      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-file-path]")) return;

      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      clearSelection();
      selectionAnchorRef.current = null;
      setKeyboardFocusPath(null);
    },
    [clearSelection],
  );

  return (
    <div className="font-workspace text-[12px] leading-[1.35] flex h-full w-full flex-col bg-transparent text-custom-sidebar-text-100">
      <div className="font-workspace text-[12px] leading-[1.35] flex h-11 items-center justify-between bg-transparent px-2 text-custom-sidebar-text-300">
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="font-workspace text-[12px] leading-[1.35] inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40"
                  aria-label="Collapse all"
                  onClick={collapseAll}
                  disabled={!hasTree}
                >
                  <Minimize2 className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("collapseAll")}
              </TooltipContent>
            </Tooltip>
            {!isWorktreeScope && (
              <>
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="font-workspace text-[12px] leading-[1.35] inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40"
                          aria-label={t("newFile")}
                        >
                          <Plus className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="center">
                      {t("newFile")}
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent
                    align="start"
                    sideOffset={4}
                    className="z-20 min-w-[160px] rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm"
                  >
                    <DropdownMenuItem
                      onSelect={() =>
                        void quickCreate(FileNodeType.File, undefined, "md")
                      }
                      className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0" />
                      <span>{t("newFileMarkdown")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        void quickCreate(
                          FileNodeType.File,
                          undefined,
                          "excalidraw",
                        )
                      }
                      className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
                    >
                      <PenLine className="h-3.5 w-3.5 shrink-0" />
                      <span>{t("newFileExcalidraw")}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() =>
                        void quickCreate(FileNodeType.File, undefined, "cbase")
                      }
                      className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
                    >
                      <Database className="h-3.5 w-3.5 shrink-0" />
                      <span>{t("newFileBase")}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="font-workspace text-[12px] leading-[1.35] inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100 disabled:pointer-events-none disabled:opacity-40"
                      aria-label="Create folder"
                      onClick={() => void quickCreate(FileNodeType.Directory)}
                    >
                      <FolderPlus className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    {t("newFolder")}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </TooltipProvider>
          {isWorktreeScope && (
            <div className="flex items-center gap-1.5">
              <div
                role="group"
                aria-label={t("worktreeFileViewLabel")}
                className="flex rounded-[5px] bg-custom-background-80 p-0.5 text-xs"
              >
                {worktreeScopeOptions.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={worktreeScopeView === value}
                    onClick={() => setWorktreeScopeView(value)}
                    className={cn(
                      "rounded-[4px] px-2 py-0.5 transition",
                      worktreeScopeView === value
                        ? "bg-custom-background-100 text-custom-text-100 shadow-sm"
                        : "text-custom-text-300 hover:text-custom-text-100",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* The dock stays an index: this opens the run-scoped gallery as
                  a center tab (same tab kind as the project-level Gallery)
                  instead of swapping the panel into a grid. */}
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={t("worktreeGalleryOpen")}
                      onClick={() =>
                        openTab(
                          {
                            type: "gallery",
                            taskRunId: scopeTaskRunId ?? undefined,
                          },
                          { activate: true },
                        )
                      }
                      className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100"
                    >
                      <Images className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="center">
                    {t("worktreeGalleryOpen")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
        </div>
        {onClose && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="font-workspace text-[12px] leading-[1.35] inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100"
                  aria-label={t("closeSidebar")}
                  onClick={onClose}
                >
                  <PanelLeftClose className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("closeSidebar")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className={`flex-1 overflow-y-auto outline-none transition-colors duration-150 ${
              externalDropState.isDraggingOver
                ? "bg-custom-primary-100/5 ring-2 ring-inset ring-custom-primary-100/50"
                : ""
            } ${showScrollBar ? "show-scrollbar" : ""}`}
            style={{
              contain: "strict",
              scrollBehavior: "auto",
              overscrollBehavior: "contain",
            }}
            data-file-tree-root="true"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: role="tree" requires keyboard focus for arrow key navigation
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onMouseDownCapture={handleMouseDownCapture}
            onClick={handleTreeClick}
            onScroll={handleTreeScroll}
            role="tree"
          >
            {isWorktreeScope &&
            worktreeScopeView === "changed" &&
            fileTree.length === 0 ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-custom-sidebar-text-400">
                {t("sessionNoChanges")}
              </div>
            ) : visibleRows.length > 0 ? (
              <div
                className="relative w-full py-2"
                style={{ height: rowVirtualizer.getTotalSize() }}
              >
                {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                  const row = visibleRows[virtualItem.index];
                  if (!row) return null;

                  const { node, isExpanded, indentPx, isWorkspaceRoot } = row;
                  const isSelected = selectedSet.has(node.path);
                  const isNewlyRevealed =
                    justExpanded != null &&
                    node.path !== justExpanded.path &&
                    node.path.startsWith(`${justExpanded.path}/`);
                  const isDirectory = node.type === FileNodeType.Directory;
                  const isDragOver =
                    dragState.dropTargetPath === node.path ||
                    externalDropState.dropTarget?.path === node.path;
                  const isDragging =
                    dragState.isDragging &&
                    dragState.draggedNodes.some(
                      (draggedNode) => draggedNode.path === node.path,
                    );
                  const matchedRoot = isWorkspaceRoot
                    ? roots.find((r) => r.path === node.path)
                    : null;
                  const operationPaths = normalizeFileOperationPaths(
                    getContextSelectionPaths(
                      selectedPaths.filter(
                        (path) => !workspaceRootPathSet.has(path),
                      ),
                      node.path,
                    ),
                  );
                  // Decorate only primary-root nodes — their vault path is
                  // exactly `/${relativePath}`, so a match excludes ad-hoc roots
                  // whose git status we don't track.
                  const relativePath = node.relativePath;
                  const nodeGitStatus =
                    relativePath && node.path === `/${relativePath}`
                      ? (isDirectory
                          ? decorations.folders.get(relativePath)
                          : decorations.files.get(relativePath)) ?? null
                      : null;

                  return (
                    <div
                      key={node.path}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: virtualItem.size,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <div
                        className={
                          isNewlyRevealed ? "tree-row-reveal" : undefined
                        }
                      >
                        <TreeContextMenu
                          node={node}
                          selectedPaths={operationPaths}
                          workspacePath={workspacePath}
                          readOnly={isWorktreeScope}
                          scopeTaskRunId={scopeTaskRunId}
                          onDelete={handleDelete}
                          onMove={handleMoveRequest}
                          onRename={handleRename}
                          onDuplicate={handleDuplicate}
                          onCreateFile={(parentPath, kind) =>
                            quickCreate(FileNodeType.File, parentPath, kind)
                          }
                          onCreateFolder={(parentPath) =>
                            quickCreate(FileNodeType.Directory, parentPath)
                          }
                          isWorkspaceRoot={isWorkspaceRoot}
                          isPrimaryRoot={matchedRoot?.isPrimary ?? false}
                          onAddFolderToProject={handleAddFolderToProject}
                          onRemoveFolderFromProject={
                            handleRemoveFolderFromProject
                          }
                        >
                          <TreeNode
                            node={node}
                            isExpanded={isExpanded}
                            isSelected={isSelected}
                            isFocused={keyboardFocusPath === node.path}
                            indentPx={indentPx}
                            isDragOver={isDragOver}
                            isDragging={isDragging}
                            gitStatus={nodeGitStatus}
                            onToggle={() => {
                              if (isDirectory) {
                                void toggleFolderWithHydration(node.path);
                              }
                            }}
                            onSelect={(event) =>
                              handleNodeSelect(
                                event,
                                node.path,
                                isWorkspaceRoot,
                              )
                            }
                            onContextMenu={() =>
                              handleNodeContextMenu(node.path)
                            }
                            onOpen={() =>
                              openFile(node.path, scopeTaskRunId ?? undefined)
                            }
                            onMouseDown={
                              isWorkspaceRoot
                                ? undefined
                                : (e) => dndHandlers.onMouseDown(e, node)
                            }
                          />
                        </TreeContextMenu>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </ContextMenuTrigger>
        {!isWorktreeScope && (
          <ContextMenuContent className="z-20 w-48 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
            <ContextMenuSub>
              <ContextMenuSubTrigger className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100">
                <FilePlus className="h-3.5 w-3.5 shrink-0" />
                <span>{t("newFile")}</span>
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="z-20 min-w-[140px] rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
                <ContextMenuItem
                  onSelect={() =>
                    void quickCreate(FileNodeType.File, rootTargetPath, "md")
                  }
                  className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("newFileMarkdown")}</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() =>
                    void quickCreate(
                      FileNodeType.File,
                      rootTargetPath,
                      "excalidraw",
                    )
                  }
                  className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
                >
                  <PenLine className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("newFileExcalidraw")}</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() =>
                    void quickCreate(FileNodeType.File, rootTargetPath, "cbase")
                  }
                  className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
                >
                  <Database className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("newFileBase")}</span>
                </ContextMenuItem>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem
              onSelect={() =>
                void quickCreate(FileNodeType.Directory, rootTargetPath)
              }
              className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
            >
              <FolderPlus className="h-3.5 w-3.5 shrink-0" />
              <span>{t("newFolder")}</span>
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={handleAddFolderToProject}
              className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
            >
              <FolderInput className="h-3.5 w-3.5 shrink-0" />
              <span>{t("addFolderToProject")}</span>
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={handleRevealRootInFinder}
              disabled={!projectId}
              className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span>{t("revealInFinder")}</span>
            </ContextMenuItem>
          </ContextMenuContent>
        )}
      </ContextMenu>
      <FolderPickerDialog
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderPickerSelect}
        title={t("addFolderToProject")}
        description={t("addFolderToProjectDescription")}
      />
      <MoveSelectionDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        fileTree={fileTree}
        rootPath={rootPath ?? "/"}
        selectedPaths={moveDialogPaths}
        onMove={handleMoveSelection}
      />
    </div>
  );
};
