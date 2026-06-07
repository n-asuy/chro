export type {};

declare global {
  interface DesktopRuntimeInfo {
    runtimeId: string | null;
    backendUrl: string;
    workspacePath: string | null;
    platform: string;
  }

  type DesktopStoredSession = {
    executor_session_id: string;
    session_id: string | null;
    prompt: string | null;
    summary: string | null;
    task_id: string;
    task_title: string;
    task_attempt_id: string;
    execution_process_id: string;
    status: string;
    exit_code: number | null;
    created_at: string;
    updated_at: string;
  };

  type WindowMode = "onboarding" | "session";

  type UpdateStatus =
    | { type: "checking" }
    | { type: "available"; version: string; releaseNotes?: string | null }
    | { type: "not-available"; version: string }
    | { type: "downloading"; percent: number }
    | { type: "downloaded"; version: string }
    | { type: "error"; message: string };

  type DesktopExecutor = "CLAUDE_CODE" | "CODEX";

  type ExecutorInstallResult = {
    ok: boolean;
    executor: DesktopExecutor;
    command: string;
    strategy: string;
    stdout: string;
    stderr: string;
    message: string;
  };

  type OpenProjectWindowResult = {
    action: "current" | "focused" | "opened";
    // Tauri-era windows are identified by string label rather than the
    // numeric BrowserWindow id the Electron build used. Callers should treat
    // this as opaque.
    windowLabel: string;
  };

  interface Window {
    desktop?: {
      getVersion?: () => Promise<string>;
      selectWorkspace?: () => Promise<string | null>;
      openProjectWindow?: (payload: {
        workspacePath: string;
        routePath: string;
        reuseCurrentWindow?: boolean;
      }) => Promise<OpenProjectWindowResult>;
      showFileContextMenu?: (payload: {
        path: string;
        name: string;
      }) => Promise<{ action: string; confirmed?: boolean } | null>;
      setWindowMode?: (mode: WindowMode) => Promise<void>;
      showNotification?: (payload: {
        title: string;
        body?: string;
      }) => Promise<void>;
      openExternalUrl?: (url: string) => Promise<void>;
      openPath?: (path: string, app?: string) => Promise<void>;
      openInCmux?: (path: string) => Promise<void>;
      installExecutor?: (
        executor: DesktopExecutor,
      ) => Promise<ExecutorInstallResult>;
      update?: {
        check: () => Promise<{
          status: string;
          updateInfo?: unknown;
          error?: string;
        }>;
        download: () => Promise<{ status: string; error?: string }>;
        install: () => Promise<void>;
        onStatusChange: (
          callback: (status: UpdateStatus) => void,
        ) => () => void;
      };
    };
    __CHRO_RUNTIME__?: DesktopRuntimeInfo;
  }
}
