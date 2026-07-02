// Compatibility shim that exposes the legacy Electron-era `window.desktop` and
// `window.__CHRO_RUNTIME__` APIs on top of Tauri 2 commands & events. Loaded
// before the React bundle from `index.html` so the shape is synchronously
// available to consumers that read it at module scope.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type WindowMode = "onboarding" | "session";
type DesktopExecutor = "CLAUDE_CODE" | "CODEX" | "PI";

type UpdateStatus =
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

type OpenProjectWindowPayload = {
  workspacePath: string;
  routePath: string;
  reuseCurrentWindow?: boolean;
};

type OpenProjectWindowResult = {
  action: "current" | "focused" | "opened";
  // The Electron build returned a numeric BrowserWindow id; Tauri uses string
  // labels. Pass the label through verbatim so existing consumers can still
  // pattern-match on the action and treat the id as opaque.
  windowLabel: string;
};

type ExecutorInstallResult = {
  ok: boolean;
  executor: DesktopExecutor;
  command: string;
  strategy: string;
  stdout: string;
  stderr: string;
  message: string;
};

const isTauri =
  typeof window !== "undefined" &&
  // @ts-expect-error — Tauri 2 marks its globals at startup
  (typeof window.__TAURI_INTERNALS__ !== "undefined" ||
    typeof (window as unknown as Record<string, unknown>).__TAURI__ !==
      "undefined");

if (isTauri) {
  ensureRuntimeInfo();
  installDesktopBridge();
}

function ensureRuntimeInfo() {
  const current = (window as unknown as Record<string, unknown>)
    .__CHRO_RUNTIME__ as RuntimeInfoPayload | undefined;
  if (current && typeof current === "object") {
    return;
  }
  // initialization_script runs before this shim, so under normal startup
  // __CHRO_RUNTIME__ is already populated. The fetch below only matters for
  // window.open()-style child webviews that bypass that hook.
  void invoke<RuntimeInfoPayload>("get_runtime_info")
    .then((payload) => {
      (window as unknown as Record<string, unknown>).__CHRO_RUNTIME__ = payload;
    })
    .catch(() => {
      (window as unknown as Record<string, unknown>).__CHRO_RUNTIME__ = {
        runtimeId: null,
        backendUrl: window.location.origin,
        workspacePath: null,
        platform: navigator.platform.toLowerCase().includes("mac")
          ? "darwin"
          : "win32",
      } satisfies RuntimeInfoPayload;
    });
}

function installDesktopBridge() {
  const desktop = {
    getVersion: () => invoke<string>("get_version"),
    selectWorkspace: () => invoke<string | null>("select_workspace"),
    openProjectWindow: (payload: OpenProjectWindowPayload) =>
      invoke<OpenProjectWindowResult>("open_project_window", { payload }),
    showFileContextMenu: (payload: { path: string; name: string }) =>
      invoke<{ action: string; confirmed?: boolean } | null>(
        "show_file_context_menu",
        { payload },
      ),
    setWindowMode: (mode: WindowMode) =>
      invoke<void>("set_window_mode", { mode }),
    showNotification: (payload: {
      title: string;
      body?: string;
      // When set, clicking the notification focuses the window and navigates to
      // this session. The Rust shell echoes it back via `notification:activate`.
      target?: { projectId: string; taskId: string };
    }) => invoke<void>("show_notification", { payload }),
    openExternalUrl: (url: string) =>
      invoke<void>("open_external_url", { url }),
    openPath: (path: string, app?: string) =>
      invoke<void>("open_path", { path, with: app ?? null }),
    openInCmux: (path: string) => invoke<void>("open_in_cmux", { path }),
    installExecutor: (executor: DesktopExecutor) =>
      invoke<ExecutorInstallResult>("install_executor", { executor }),
    update: {
      check: () =>
        invoke<{ status: string; updateInfo?: unknown; error?: string }>(
          "update_check",
        ),
      download: () =>
        invoke<{ status: string; error?: string }>("update_download"),
      install: () => invoke<void>("update_install"),
      onStatusChange: (callback: (status: UpdateStatus) => void) => {
        const unlistenPromise = listen<UpdateStatus>("update:status", (event) =>
          callback(event.payload),
        );
        return () => {
          void unlistenPromise.then((u) => u());
        };
      },
    },
  } as const;

  (window as unknown as Record<string, unknown>).desktop = desktop;
}
