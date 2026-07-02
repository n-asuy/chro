import { useLanguage } from "@/i18n";
import {
  resolveTaskRunAbsolutePath,
  revealInFinder,
  revealTaskRunInFinder,
} from "@/lib/project-client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@chro/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@chro/ui/context-menu";
import {
  Copy,
  CopyPlus,
  Database,
  ExternalLink,
  FilePlus,
  FileText,
  FolderInput,
  FolderPlus,
  FolderX,
  PenLine,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useProjectId } from "../../context/project-context";
import type { FileNode, NewFileKind } from "../../types/file-tree";
import { FileNodeType } from "../../types/file-tree";

interface TreeContextMenuProps {
  children: React.ReactNode;
  node: FileNode;
  workspacePath: string | null;
  onDelete: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onDuplicate: (path: string) => void;
  onCreateFile: (parentPath: string, kind?: NewFileKind) => void;
  onCreateFolder: (parentPath: string) => void;
  /** True for synthetic worktree-root rows; swaps the menu for root actions. */
  isWorkspaceRoot?: boolean;
  /** Whether this root is the project's primary workspace (cannot be removed). */
  isPrimaryRoot?: boolean;
  onAddFolderToProject?: () => void;
  onRemoveFolderFromProject?: (path: string) => void;
  /**
   * Read-only scope (a session sandbox): mutating actions are suppressed and
   * only scope-correct, non-destructive items (copy paths, reveal) remain.
   */
  readOnly?: boolean;
  /**
   * Active task-run id when this tree is scoped to a session sandbox. Routes
   * path resolution and reveal through the run's worktree instead of the
   * project checkout. Null/undefined in project scope.
   */
  scopeTaskRunId?: string | null;
}

export const TreeContextMenu = ({
  children,
  node,
  workspacePath,
  onDelete,
  onRename,
  onDuplicate,
  onCreateFile,
  onCreateFolder,
  isWorkspaceRoot = false,
  isPrimaryRoot = false,
  onAddFolderToProject,
  onRemoveFolderFromProject,
  readOnly = false,
  scopeTaskRunId = null,
}: TreeContextMenuProps) => {
  const { t } = useLanguage();
  const projectId = useProjectId();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleRename = () => {
    onRename(node.path, node.name);
  };

  const handleDuplicate = () => {
    onDuplicate(node.path);
  };

  const handleDeleteClick = () => {
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = () => {
    onDelete(node.path);
    setShowDeleteDialog(false);
  };

  const handleCopyFullPath = async () => {
    // node.path starts with "/" (e.g., "/src/index.ts")
    // workspacePath is the absolute path (e.g., "/Users/xxx/project")
    // Result should be "/Users/xxx/project/src/index.ts"
    const relativePart = node.path.startsWith("/")
      ? node.path.slice(1)
      : node.path;
    const fullPath = workspacePath
      ? `${workspacePath}/${relativePart}`
      : node.path;
    await navigator.clipboard.writeText(fullPath);
  };

  const handleCopyRelativePath = async () => {
    // Remove leading slash if present for relative path
    const relativePath = node.path.startsWith("/")
      ? node.path.slice(1)
      : node.path;
    await navigator.clipboard.writeText(relativePath);
  };

  const handleRevealInFinder = () => {
    if (!projectId) return;
    revealInFinder(projectId, node.path).catch((err) => {
      console.warn("[tree-context-menu] Failed to reveal in finder:", err);
    });
  };

  // Session-sandbox variants: the worktree root lives server-side only, so both
  // the absolute path and the reveal are resolved by the run-scoped endpoints
  // against the run's worktree rather than the project checkout.
  const handleCopyAbsolutePathWorktree = async () => {
    if (!scopeTaskRunId) return;
    try {
      const absolutePath = await resolveTaskRunAbsolutePath(
        scopeTaskRunId,
        node.path,
      );
      await navigator.clipboard.writeText(absolutePath);
    } catch (err) {
      console.warn("[tree-context-menu] Failed to copy absolute path:", err);
    }
  };

  const handleRevealInFinderWorktree = () => {
    if (!scopeTaskRunId) return;
    revealTaskRunInFinder(scopeTaskRunId, node.path).catch((err) => {
      console.warn("[tree-context-menu] Failed to reveal in finder:", err);
    });
  };

  const isDirectory = node.type === FileNodeType.Directory;

  // For directories, create inside; for files, create in parent directory
  const targetParentPath = isDirectory
    ? node.path
    : node.path.substring(0, node.path.lastIndexOf("/")) || "/";

  const handleCreateFile = (kind: NewFileKind) => {
    onCreateFile(targetParentPath, kind);
  };

  const handleCreateFolder = () => {
    onCreateFolder(targetParentPath);
  };

  // Read-only scope (session sandbox): no create/rename/delete — those mutate
  // the project. Root rows get no menu; file/dir rows keep the non-destructive,
  // worktree-resolved items (copy paths + reveal in the run's sandbox).
  if (readOnly) {
    if (isWorkspaceRoot) {
      return <div className="block">{children}</div>;
    }
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="block">{children}</div>
        </ContextMenuTrigger>
        <ContextMenuContent className="z-20 w-48 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
          <ContextMenuItem
            onSelect={handleCopyAbsolutePathWorktree}
            disabled={!scopeTaskRunId}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
          >
            <Copy className="h-3.5 w-3.5 shrink-0" />
            <span>{t("copyFullPath")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={handleCopyRelativePath}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span>{t("copyRelativePath")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={handleRevealInFinderWorktree}
            disabled={!scopeTaskRunId}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span>{t("revealInFinder")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (isWorkspaceRoot) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="block">{children}</div>
        </ContextMenuTrigger>
        <ContextMenuContent className="z-20 w-56 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
          <ContextMenuSub>
            <ContextMenuSubTrigger className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100">
              <FilePlus className="h-3.5 w-3.5 shrink-0" />
              <span>{t("newFile")}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="z-20 min-w-[140px] rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
              <ContextMenuItem
                onSelect={() => handleCreateFile("md")}
                className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span>{t("newFileMarkdown")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => handleCreateFile("excalidraw")}
                className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <PenLine className="h-3.5 w-3.5 shrink-0" />
                <span>{t("newFileExcalidraw")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => handleCreateFile("cbase")}
                className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <Database className="h-3.5 w-3.5 shrink-0" />
                <span>{t("newFileBase")}</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            onSelect={handleCreateFolder}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" />
            <span>{t("newFolder")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={() => onAddFolderToProject?.()}
            disabled={!onAddFolderToProject}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
          >
            <FolderInput className="h-3.5 w-3.5 shrink-0" />
            <span>{t("addFolderToProject")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => onRemoveFolderFromProject?.(node.path)}
            disabled={!onRemoveFolderFromProject}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100 data-[disabled]:pointer-events-none data-[disabled]:opacity-40"
          >
            <FolderX className="h-3.5 w-3.5 shrink-0" />
            <span>{t("removeFolderFromProject")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={handleRevealInFinder}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span>{t("revealInFinder")}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="block">{children}</div>
        </ContextMenuTrigger>
        <ContextMenuContent className="z-20 w-48 rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
          <ContextMenuSub>
            <ContextMenuSubTrigger className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100">
              <FilePlus className="h-3.5 w-3.5 shrink-0" />
              <span>{t("newFile")}</span>
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="z-20 min-w-[140px] rounded-xl border border-custom-border-200 bg-custom-background-100 p-1 shadow-sm">
              <ContextMenuItem
                onSelect={() => handleCreateFile("md")}
                className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span>{t("newFileMarkdown")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => handleCreateFile("excalidraw")}
                className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <PenLine className="h-3.5 w-3.5 shrink-0" />
                <span>{t("newFileExcalidraw")}</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => handleCreateFile("cbase")}
                className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
              >
                <Database className="h-3.5 w-3.5 shrink-0" />
                <span>{t("newFileBase")}</span>
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            onSelect={handleCreateFolder}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0" />
            <span>{t("newFolder")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={handleCopyFullPath}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <Copy className="h-3.5 w-3.5 shrink-0" />
            <span>{t("copyFullPath")}</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={handleCopyRelativePath}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span>{t("copyRelativePath")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={handleRevealInFinder}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            <span>{t("revealInFinder")}</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={handleDuplicate}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <CopyPlus className="h-3.5 w-3.5 shrink-0" />
            <span>Duplicate</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={handleRename}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-custom-background-90 focus:text-custom-text-100"
          >
            <Pencil className="h-3.5 w-3.5 shrink-0" />
            <span>Rename</span>
          </ContextMenuItem>
          <ContextMenuSeparator className="mx-1 my-1 bg-custom-border-200" />
          <ContextMenuItem
            onSelect={handleDeleteClick}
            className="font-workspace flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[12px] text-custom-text-200 focus:bg-red-50 focus:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>Delete</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="border border-custom-border-200 bg-custom-background-100">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-custom-text-100">
              Delete {node.name}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-custom-text-300">
              This action cannot be undone. This will permanently delete the{" "}
              {isDirectory ? "folder and all its contents" : "file"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-custom-border-200 bg-custom-background-90 text-custom-text-200 hover:bg-custom-background-80 hover:text-custom-text-100">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-red-500 text-white hover:bg-red-600"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
