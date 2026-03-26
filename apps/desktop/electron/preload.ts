import { contextBridge, ipcRenderer } from "electron";

type WindowMode = "onboarding" | "session";

export type UpdateStatus =
  | { type: "checking" }
  | { type: "available"; version: string; releaseNotes?: string | null }
  | { type: "not-available"; version: string }
  | { type: "downloading"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

type RuntimeInfoPayload = {
  runtimeId: string | null;
  backendUrl: string;
  workspacePath: string | null;
  platform: string;
};

const runtimeInfo = ipcRenderer.sendSync(
  "desktop:get-runtime-info",
) as RuntimeInfoPayload;
contextBridge.exposeInMainWorld("__CHRO_RUNTIME__", runtimeInfo);

contextBridge.exposeInMainWorld("desktop", {
  getVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
  selectWorkspace: () =>
    ipcRenderer.invoke("desktop:select-workspace") as Promise<string | null>,
  openWorkspaceLauncher: () =>
    ipcRenderer.invoke("desktop:open-workspace-launcher") as Promise<void>,
  showFileContextMenu: (payload: { path: string; name: string }) =>
    ipcRenderer.invoke("desktop:show-file-context-menu", payload) as Promise<{
      action: string;
      confirmed?: boolean;
    } | null>,
  setWindowMode: (mode: WindowMode) =>
    ipcRenderer.invoke("window:set-mode", mode) as Promise<void>,
  showNotification: (payload: { title: string; body?: string }) =>
    ipcRenderer.invoke("desktop:show-notification", payload) as Promise<void>,
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke("desktop:open-external", { url }) as Promise<void>,

  update: {
    check: () =>
      ipcRenderer.invoke("update:check") as Promise<{
        status: string;
        updateInfo?: unknown;
        error?: string;
      }>,
    download: () =>
      ipcRenderer.invoke("update:download") as Promise<{
        status: string;
        error?: string;
      }>,
    install: () => ipcRenderer.invoke("update:install") as Promise<void>,
    onStatusChange: (callback: (status: UpdateStatus) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: UpdateStatus,
      ) => callback(status);
      ipcRenderer.on("update:status", handler);
      return () => {
        ipcRenderer.removeListener("update:status", handler);
      };
    },
  },
});
