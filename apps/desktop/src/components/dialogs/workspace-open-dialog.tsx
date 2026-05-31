import { FolderPickerDialog } from "@/components/dialogs/folder-picker-dialog";
import { filesystemApi } from "@/lib/filesystem-client";
import { prepareWorkspace } from "@/lib/open-workspace";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

interface WorkspaceOpenDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Shared "open a workspace" flow built on the in-app folder browser
 * (`FolderPickerDialog`), which surfaces git-repo indicators so the user can
 * tell a real repository from a plain folder before selecting it. On select it
 * ensures the project and navigates to its session — used by both the boot home
 * and the project switcher's "New workspace".
 */
export function WorkspaceOpenDialog({
  open,
  onOpenChange,
}: WorkspaceOpenDialogProps) {
  const navigate = useNavigate();
  const [initialPath, setInitialPath] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    filesystemApi
      .getCurrentDirectory()
      .then(({ path }) => {
        if (!cancelled) setInitialPath(path);
      })
      .catch(() => {
        if (!cancelled) setInitialPath("");
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSelect = useCallback(
    async (path: string | null) => {
      if (!path) return;
      try {
        const landing = await prepareWorkspace(path);
        navigate({ to: landing });
      } catch (err) {
        console.error("[workspace] Failed to open selected folder", err);
      }
    },
    [navigate],
  );

  return (
    <FolderPickerDialog
      open={open}
      onOpenChange={onOpenChange}
      onSelect={handleSelect}
      initialPath={initialPath}
      title="Select workspace"
      description="Choose a folder to open as your workspace"
    />
  );
}
