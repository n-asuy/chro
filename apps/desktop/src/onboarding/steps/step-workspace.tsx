import { FolderPickerDialog } from "@/components/dialogs/folder-picker-dialog";
import { filesystemApi } from "@/lib/filesystem-client";
import { prepareWorkspace } from "@/lib/open-workspace";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRight, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * Onboarding step 3: open the first project. Chro registers a local folder as a
 * project (git repos are detected by the in-app folder browser); it has no
 * clone-from-URL flow, so this step offers exactly what the app can do — open a
 * folder. On a successful open we mark onboarding complete and navigate into the
 * project, which unmounts the flow.
 */
export function StepWorkspace({ onOpened }: { onOpened: () => void }) {
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [initialPath, setInitialPath] = useState("");

  useEffect(() => {
    if (!pickerOpen) return;
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
  }, [pickerOpen]);

  const handleSelect = useCallback(
    async (path: string | null) => {
      if (!path) return;
      try {
        const landing = await prepareWorkspace(path);
        // Mark complete before navigating so the flow doesn't re-open on the
        // project route.
        onOpened();
        navigate({ to: landing });
      } catch (err) {
        console.error("[onboarding] Failed to open selected folder", err);
      }
    },
    [navigate, onOpened],
  );

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="flex w-full items-center gap-3.5 rounded-lg border border-custom-border-200 bg-custom-background-90 p-4 text-left transition-colors hover:border-custom-border-300 hover:bg-custom-background-80"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-custom-background-80">
          <FolderOpen className="size-5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">
            Open a folder
          </span>
          <span className="block text-xs text-muted-foreground">
            Choose an existing folder on this machine — git repos are detected
          </span>
        </span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
      </button>

      <p className="text-center text-xs text-muted-foreground">
        Chro creates an isolated worktree per task, so your main branch stays
        untouched.
      </p>

      <FolderPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={handleSelect}
        initialPath={initialPath}
        title="Select workspace"
        description="Choose a folder to open as your workspace"
      />
    </div>
  );
}
