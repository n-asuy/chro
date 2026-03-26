import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@chro/ui/button";
import { taskApi } from "@/kanban/api/task-api";
import {
  getRecentWorkspaces,
  touchRecentWorkspace,
  type RecentWorkspace,
} from "@/lib/workspace-history";
import { FolderPickerDialog } from "@/components/dialogs/folder-picker-dialog";
import { filesystemApi } from "@/lib/filesystem-client";

export const Route = createFileRoute("/workspace")({
  component: WorkspacePage,
});

const sanitizePath = (path: string): string => {
  if (!path) return "";
  const normalized = path.replace(/\\+/g, "/");
  if (/^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+/g, "/").replace(/\/$/, "");
};

const getFolderLabel = (path: string): string => {
  const sanitized = sanitizePath(path);
  if (!sanitized) return path;
  if (/^[a-zA-Z]:\/$/.test(sanitized)) {
    return sanitized;
  }
  const withoutTrailing = sanitized.replace(/\/$/, "");
  const segments = withoutTrailing.split("/");
  return segments.pop() || withoutTrailing;
};

type WorkspaceState = {
  path: string | null;
  exists: boolean;
};

const getDesktop = () =>
  typeof window === "undefined" ? undefined : window.desktop;
const hasElectronFolderPicker = () => Boolean(getDesktop()?.selectWorkspace);

function WorkspacePage() {
  const navigate = useNavigate();
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState | null>(
    null
  );
  const [bootstrapping, setBootstrapping] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [interactionPending, setInteractionPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspace[]>(
    []
  );
  const shouldNavigateToSession = useRef(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [folderPickerInitialPath, setFolderPickerInitialPath] = useState("");
  const [isElectronMode, setIsElectronMode] = useState(false);

  const loadLocalWorkspaceState = useCallback(() => {
    const recent = getRecentWorkspaces();
    setRecentWorkspaces(recent);
    setWorkspaceState({ path: null, exists: false });
  }, []);

  useEffect(() => {
    loadLocalWorkspaceState();
    setIsElectronMode(hasElectronFolderPicker());
    setBootstrapping(false);
    window.desktop?.setWindowMode?.("onboarding");
  }, [loadLocalWorkspaceState]);

  const navigateToProject = useCallback(
    async (path: string) => {
      setInteractionPending(true);
      setErrorMessage(null);
      try {
        setRecentWorkspaces(touchRecentWorkspace(path));
        const projectId = await taskApi.ensureProject(path);
        navigate({ to: "/projects/$projectId/session", params: { projectId } });
      } catch (err) {
        console.error("[onboarding] Failed to ensure project", err);
        setErrorMessage("Failed to initialize project. Please try again.");
      } finally {
        setInteractionPending(false);
      }
    },
    [navigate]
  );

  const handleChooseFolder = useCallback(async () => {
    if (isElectronMode) {
      const selectWorkspace = getDesktop()?.selectWorkspace;
      if (!selectWorkspace) {
        setErrorMessage("Folder selection is not available.");
        return;
      }
      setInteractionPending(true);
      setErrorMessage(null);
      try {
        const result = await selectWorkspace();
        if (result) {
          setWorkspaceState({ path: result, exists: true });
          await navigateToProject(result);
        }
      } catch (error) {
        console.error("[onboarding] Workspace selection failed", error);
        setErrorMessage(
          error instanceof Error ? error.message : "Unable to select workspace"
        );
      } finally {
        setInteractionPending(false);
      }
    } else {
      try {
        const { path } = await filesystemApi.getCurrentDirectory();
        setFolderPickerInitialPath(path);
      } catch {
        setFolderPickerInitialPath("");
      }
      setFolderPickerOpen(true);
    }
  }, [isElectronMode, navigateToProject]);

  const handleFolderPickerSelect = useCallback(
    async (path: string | null) => {
      if (path) {
        setInteractionPending(true);
        setErrorMessage(null);
        try {
          setWorkspaceState({ path, exists: true });
          await navigateToProject(path);
        } catch (error) {
          console.error("[onboarding] Navigation failed", error);
          setErrorMessage(
            error instanceof Error ? error.message : "Failed to open workspace"
          );
        } finally {
          setInteractionPending(false);
        }
      }
    },
    [navigateToProject]
  );

  const handleUseRecent = useCallback(
    async (path: string) => {
      setWorkspaceState({ path, exists: true });
      await navigateToProject(path);
    },
    [navigateToProject]
  );

  const activeWorkspaceLabel = useMemo(() => {
    if (!workspaceState?.path) return null;
    return {
      title: getFolderLabel(workspaceState.path),
      fullPath: sanitizePath(workspaceState.path),
    };
  }, [workspaceState?.path]);

  const isBusy = bootstrapping || syncing || interactionPending;

  return (
    <div className="flex min-h-screen">
      <div className="flex flex-1 flex-col items-center justify-center bg-[#181818] px-4">
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col items-center gap-4">
            <img
              src="/logo_chro_invert.png"
              alt="Chro"
              width={140}
              height={37}
              className="h-9 w-auto"
            />
            <p className="text-sm font-light text-white/55">
              Select a workspace to continue
            </p>
          </div>

          <div className="w-full border border-white/10 bg-[#0a0a0a] p-6">
              <div className="space-y-6">
                <div className="flex items-center gap-3">
                  <FolderOpen className="size-5 text-white/70" />
                  <div>
                    <p className="text-sm font-light text-white">
                      Workspace folder
                    </p>
                    <p className="text-xs font-light text-white/40">
                      Select a local directory to open Chro.
                    </p>
                  </div>
                </div>

                <div className="border border-white/10 bg-white/5 p-4">
                  {activeWorkspaceLabel ? (
                    <div>
                      <p className="text-sm font-light text-white">
                        {activeWorkspaceLabel.title}
                      </p>
                      <p
                        className="text-xs font-light text-white/40"
                        title={activeWorkspaceLabel.fullPath}
                      >
                        {activeWorkspaceLabel.fullPath}
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm font-light text-white">
                        No folder selected
                      </p>
                      <p className="text-xs font-light text-white/40">
                        Pick a directory to unlock the desktop session surface.
                      </p>
                    </div>
                  )}
                </div>

                <Button
                  size="lg"
                  className="w-full justify-center rounded-none border border-white/10 bg-transparent text-sm font-light text-white transition-colors hover:bg-white/5"
                  onClick={handleChooseFolder}
                  disabled={isBusy}
                >
                  {interactionPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  Choose folder
                </Button>

                {recentWorkspaces.length > 0 ? (
                  <div className="space-y-3 pt-2">
                    <div className="flex items-center gap-2">
                      <div className="h-px flex-1 bg-white/10" />
                      <p className="text-xs font-light uppercase tracking-wide text-white/40">
                        Previously opened
                      </p>
                      <div className="h-px flex-1 bg-white/10" />
                    </div>
                    <div className="space-y-2">
                      {recentWorkspaces.map((entry) => (
                        <button
                          key={`${entry.path}-${entry.lastOpenedAt}`}
                          type="button"
                          className="flex w-full items-center justify-between border border-white/10 bg-transparent px-3 py-3 text-left text-sm text-white transition-colors hover:bg-white/5"
                          onClick={() => handleUseRecent(entry.path)}
                          disabled={isBusy}
                        >
                          <div>
                            <p className="font-light">
                              {getFolderLabel(entry.path)}
                            </p>
                            <p
                              className="text-xs font-light text-white/40"
                              title={entry.path}
                            >
                              {sanitizePath(entry.path)}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

            {errorMessage ? (
              <p className="mt-6 border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm font-light text-red-400">
                {errorMessage}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {bootstrapping ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[#181818]/90">
          <div className="flex items-center gap-3 border border-white/10 bg-[#0a0a0a] px-4 py-2 text-sm font-light text-white">
            <Loader2 className="size-4 animate-spin" />
            Loading...
          </div>
        </div>
      ) : null}

      <FolderPickerDialog
        open={folderPickerOpen}
        onOpenChange={setFolderPickerOpen}
        onSelect={handleFolderPickerSelect}
        initialPath={folderPickerInitialPath}
        title="Select Workspace"
        description="Choose a folder to open as your workspace"
      />
    </div>
  );
}
