import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  Menu,
  Notification,
  type OpenDialogOptions,
  app,
  dialog,
  ipcMain,
  screen,
} from "electron";
import { type UpdateInfo, autoUpdater } from "electron-updater";
import {
  type SessionDatabase,
  configureSharedUserData,
  createSessionDatabase,
} from "./db";
import { type DesktopExecutor, installExecutor } from "./executor-installer";
import { migrateLegacyUserData } from "./migration";
import { findAvailablePort } from "./port-utils";
import {
  APP_PROTOCOL_SCHEME,
  registerAppProtocolHandler,
  registerAppProtocolScheme,
  resolveDistDir,
} from "./protocol";
import { openExternalUrl } from "./shell-utils";
import {
  destroyTray,
  initTray,
  refreshTrayMenu,
  updateTrayState,
} from "./tray";
import type { TrayWorkspaceWindow } from "./tray";

app.setName("Chro");

app.setAboutPanelOptions({
  applicationName: "Chro",
});
// Register app:// protocol scheme before app.whenReady()
registerAppProtocolScheme();
// Migrate legacy "Chronist" directory to "Chro" before configuring userData
migrateLegacyUserData(app);
// Configure userData path before app.whenReady() to ensure localStorage uses the correct path
const userDataDir = configureSharedUserData(app);

type DesktopErrorCode =
  | "WORKSPACE_NOT_SET"
  | "SELECTION_CANCELED"
  | "INVALID_PATH";

type TrayStatus = ReturnType<typeof import("./tray").getTrayState>["status"];

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";
const isAutoUpdaterEnabled = (() => {
  const value = process.env.CHRO_ENABLE_AUTO_UPDATER?.trim().toLowerCase();
  if (!value) return false;
  return value === "1" || value === "true" || value === "yes" || value === "on";
})();
const DEFAULT_DEV_URL = process.env.ELECTRON_DEV_URL ?? "http://localhost:3400";
const projectRoot = path.join(__dirname, "..");
const repoRoot = path.resolve(projectRoot, "..", "..");

const SERVER_HOST = process.env.CHRO_SERVER_HOST ?? "127.0.0.1";
const SERVER_PORT = Number(process.env.CHRO_SERVER_PORT ?? "4310");

const findAvailableServerPort = async (
  startPort = SERVER_PORT,
): Promise<number> => findAvailablePort(startPort, SERVER_HOST);

type WindowMode = "onboarding" | "session";

type WindowPreset = {
  widthRatio: number;
  heightRatio: number;
  minWidth: number;
  minHeight: number;
  minWindowWidth: number;
  minWindowHeight: number;
  fixedWidth?: number;
  fixedHeight?: number;
};

const WINDOW_PRESETS: Record<WindowMode, WindowPreset> = {
  onboarding: {
    widthRatio: 0,
    heightRatio: 0,
    minWidth: 840,
    minHeight: 720,
    minWindowWidth: 840,
    minWindowHeight: 720,
    fixedWidth: 840,
    fixedHeight: 720,
  },
  session: {
    widthRatio: 0.8,
    heightRatio: 0.9,
    minWidth: 1280,
    minHeight: 800,
    minWindowWidth: 1100,
    minWindowHeight: 720,
  },
};

const DEFAULT_WINDOW_PRESET: WindowPreset = WINDOW_PRESETS.session;

type RuntimeContext = {
  id: string;
  dir: string;
  port: number;
  baseUrl: string;
  process: ChildProcessWithoutNullStreams;
  sessionDatabase: SessionDatabase;
  workspacePath: string | null;
};

type WindowContext = {
  runtimeId: string;
  window: BrowserWindow;
};

const runtimeContexts = new Map<string, RuntimeContext>();
const windowContexts = new Map<number, WindowContext>();
const windowModes = new Map<number, WindowMode>();
let activeWindowId: number | null = null;

const normalizeWorkspaceBasename = (
  workspacePath: string | null,
): string | null => {
  if (!workspacePath) return null;
  const normalized = workspacePath.replace(/\\+/g, "/").replace(/\/+$/, "");
  if (!normalized) return null;
  const segments = normalized.split("/");
  const lastSegment = segments[segments.length - 1];
  return lastSegment || normalized;
};

const describeWorkspaceWindows = (): TrayWorkspaceWindow[] => {
  const focusedWindowId =
    activeWindowId ?? BrowserWindow.getFocusedWindow()?.id ?? null;

  const entries = Array.from(windowContexts.values()).flatMap(
    ({ runtimeId, window }) => {
      if (window.isDestroyed()) {
        return [];
      }
      const mode = windowModes.get(window.id) ?? "session";
      if (mode !== "session") {
        return [];
      }
      const runtime = runtimeContexts.get(runtimeId) ?? null;
      const workspacePath = runtime?.workspacePath ?? null;
      const label =
        normalizeWorkspaceBasename(workspacePath) ??
        window.getTitle() ??
        "Workspace";
      const description = workspacePath ? null : "No workspace selected";

      const entry: TrayWorkspaceWindow = {
        windowId: window.id,
        label,
        workspacePath,
        description,
        mode: "session",
        isFocused: focusedWindowId === window.id,
      };

      return [entry];
    },
  );

  return entries.sort((a, b) => {
    if (a.isFocused && !b.isFocused) return -1;
    if (!a.isFocused && b.isFocused) return 1;
    if (a.label === b.label) {
      return a.windowId - b.windowId;
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
};

type ServerCommand = {
  command: string;
  args: string[];
  cwd?: string;
};

const resolveRustServerCommand = (): ServerCommand => {
  const binaryName =
    process.platform === "win32" ? "chro-server.exe" : "chro-server";
  const packagedBinary = path.join(
    process.resourcesPath,
    "rust-server",
    binaryName,
  );
  if (!isDev && fs.existsSync(packagedBinary)) {
    return { command: packagedBinary, args: [] };
  }

  const buildProfile = app.isPackaged ? "release" : "debug";
  const localBinary = path.join(
    repoRoot,
    "crates",
    "server",
    "target",
    buildProfile,
    binaryName,
  );
  if (fs.existsSync(localBinary)) {
    return { command: localBinary, args: [], cwd: repoRoot };
  }

  return {
    command: "cargo",
    args: [
      "run",
      "--manifest-path",
      path.join(repoRoot, "crates", "server", "Cargo.toml"),
      "--",
    ],
    cwd: repoRoot,
  };
};

const waitForServerReady = async (
  url: string,
  attempts = 40,
): Promise<void> => {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Rust server did not become ready in time");
};

type RuntimeLaunchOptions = {
  dir: string;
  useDefaultConfigPath?: boolean;
};

const launchRuntime = async (
  options: RuntimeLaunchOptions,
): Promise<RuntimeContext> => {
  const runtimeId = randomUUID();
  await fsPromises.mkdir(options.dir, { recursive: true });
  const dbPath = path.join(options.dir, "db.sqlite");
  const serverCommand = resolveRustServerCommand();
  const port = await findAvailableServerPort();
  const serverArgs = [
    ...serverCommand.args,
    "--db-path",
    dbPath,
    "--host",
    SERVER_HOST,
    "--port",
    String(port),
    "--no-open",
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUST_LOG:
      process.env.RUST_LOG ??
      "info,tower_http=debug,server=debug,local_runtime=debug,runtime=debug,executors=debug",
  };
  if (!options.useDefaultConfigPath) {
    env.CHRO_CONFIG_PATH = path.join(options.dir, "config.json");
  }

  const processHandle = spawn(serverCommand.command, serverArgs, {
    cwd: serverCommand.cwd,
    env,
  });
  const baseUrl = `http://${SERVER_HOST}:${port}`;

  const forwardLogs = (
    chunk: Buffer,
    method: (msg?: unknown, ...args: unknown[]) => void,
  ) => {
    const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      method(`[chro-server:${runtimeId}] ${line}`);
    }
  };

  processHandle.stdout?.on("data", (chunk) => forwardLogs(chunk, console.log));
  processHandle.stderr?.on("data", (chunk) => forwardLogs(chunk, console.warn));
  processHandle.on("exit", (code, signal) => {
    console.warn(`[desktop] Runtime ${runtimeId} exited`, { code, signal });
    runtimeContexts.delete(runtimeId);
  });

  await waitForServerReady(`${baseUrl}/health`);

  const runtime: RuntimeContext = {
    id: runtimeId,
    dir: options.dir,
    port,
    baseUrl,
    process: processHandle,
    sessionDatabase: createSessionDatabase(options.dir, { baseUrl }),
    workspacePath: null,
  };
  runtimeContexts.set(runtimeId, runtime);
  return runtime;
};

const disposeRuntime = (runtimeId: string) => {
  const runtime = runtimeContexts.get(runtimeId);
  if (!runtime) return;
  runtime.sessionDatabase.close();
  runtime.process.kill();
  runtimeContexts.delete(runtimeId);
};

const releaseRuntimeIfUnused = (runtimeId: string) => {
  const stillInUse = Array.from(windowContexts.values()).some(
    (context) => context.runtimeId === runtimeId,
  );
  if (stillInUse) return;

  // window.open() can create renderer windows that are not tracked in windowContexts.
  // Keep runtime alive while any BrowserWindow still exists.
  const hasAnyWindowOpen = BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed(),
  );
  if (hasAnyWindowOpen) return;

  disposeRuntime(runtimeId);
};

const prepareRuntime = async (
  dir: string,
  useDefaultConfigPath = false,
): Promise<RuntimeContext> => {
  const runtime = await launchRuntime({ dir, useDefaultConfigPath });
  return runtime;
};
let mainWindow: BrowserWindow | null = null;
let primaryRuntimeDir: string | null = null;
const UPDATE_STATUS_CHANNEL = "update:status";

type WindowStatePayload = {
  isMaximized: boolean;
};

const WINDOW_STATE_CHANNEL = "window:state-change";

const getStatePayload = (window: BrowserWindow | null): WindowStatePayload => ({
  isMaximized: window?.isMaximized() ?? false,
});

const sendWindowState = (window: BrowserWindow | null) => {
  if (!window) return;
  window.webContents.send(WINDOW_STATE_CHANNEL, getStatePayload(window));
};

const sendToRenderer = (channel: string, payload: unknown) => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
};

const createDesktopError = (code: DesktopErrorCode, message: string) => {
  const error = new Error(message) as Error & { code: DesktopErrorCode };
  error.name = "DesktopError";
  error.code = code;
  return error;
};

const generateId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeNonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const ok = <T extends Record<string, unknown> = Record<string, never>>(
  extra?: T,
) => ({
  ok: true as const,
  ...(extra ?? ({} as T)),
});

const fail = <
  E extends string,
  T extends Record<string, unknown> = Record<string, never>,
>(
  error: E,
  extra?: T,
) => ({
  ok: false as const,
  error,
  ...(extra ?? ({} as T)),
});

const isDirectory = async (target: string | null): Promise<boolean> => {
  if (!target) return false;
  try {
    const stats = await fsPromises.stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

const setWorkspacePath = (runtime: RuntimeContext, nextPath: string | null) => {
  runtime.workspacePath = nextPath;
  refreshTrayMenu();
};

const promptForWorkspace = async (
  runtime: RuntimeContext,
  owner?: BrowserWindow | null,
): Promise<string | null> => {
  const dialogOptions: OpenDialogOptions = {
    title: "Select workspace folder",
    properties: ["openDirectory", "createDirectory", "promptToCreate"],
  };

  const browserOwner = owner ?? mainWindow ?? null;
  const result = browserOwner
    ? await dialog.showOpenDialog(browserOwner, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const selectedPath = result.filePaths[0]!;
  if (!(await isDirectory(selectedPath))) {
    const messageBoxOptions = {
      type: "error",
      title: "Not a directory",
      message:
        "The selected path is not a directory. Please choose another folder.",
    } as const;

    if (browserOwner) {
      await dialog.showMessageBox(browserOwner, messageBoxOptions);
    } else {
      await dialog.showMessageBox(messageBoxOptions);
    }
    return null;
  }

  setWorkspacePath(runtime, selectedPath);
  return selectedPath;
};

const getRuntimeForWindow = (
  window?: BrowserWindow | null,
): RuntimeContext | null => {
  if (!window) return getPrimaryRuntime();
  const context = windowContexts.get(window.id);
  if (!context) return getPrimaryRuntime();
  return runtimeContexts.get(context.runtimeId) ?? getPrimaryRuntime();
};

const getPrimaryRuntime = (): RuntimeContext | null => {
  // Return the first available runtime (primary runtime)
  const [runtime] = runtimeContexts.values();
  return runtime ?? null;
};

const openWorkspaceLauncherWindow = async () => {
  const runtime = getPrimaryRuntime();
  if (!runtime) {
    throw new Error("No runtime available to create new window");
  }
  const window = await createRendererWindow(runtime, "onboarding");
  return window;
};

const syncTrayState = (status?: TrayStatus) => {
  updateTrayState({
    taskCount: 0,
    status: status ?? "connected",
  });
};

const resolveWorkArea = (targetWindow: BrowserWindow | null = null) => {
  const referenceWindow = targetWindow ?? mainWindow;
  if (referenceWindow) {
    try {
      const display = screen.getDisplayMatching(referenceWindow.getBounds());
      return display.workArea;
    } catch (error) {
      console.warn("[desktop] Failed to resolve display for window", error);
    }
  }
  return screen.getPrimaryDisplay().workArea;
};

const calculateWindowBounds = (
  targetWindow: BrowserWindow | null = null,
  mode: WindowMode = "session",
) => {
  const workArea = resolveWorkArea(targetWindow);
  const preset = WINDOW_PRESETS[mode];

  let constrainedWidth: number;
  let constrainedHeight: number;

  if (preset.fixedWidth && preset.fixedHeight) {
    constrainedWidth = preset.fixedWidth;
    constrainedHeight = preset.fixedHeight;
  } else {
    const idealWidth = Math.floor(workArea.width * preset.widthRatio);
    constrainedWidth = Math.min(
      workArea.width,
      Math.max(idealWidth, preset.minWidth),
    );
    const idealHeight = Math.floor(workArea.height * preset.heightRatio);
    constrainedHeight = Math.min(
      workArea.height,
      Math.max(idealHeight, preset.minHeight),
    );
  }

  const centerX =
    workArea.x + Math.floor((workArea.width - constrainedWidth) / 2);
  const centerY =
    workArea.y + Math.floor((workArea.height - constrainedHeight) / 2);
  return {
    x: centerX,
    y: centerY,
    width: constrainedWidth,
    height: constrainedHeight,
  };
};
const applyWindowConstraints = (
  targetWindow: BrowserWindow | null = null,
  mode: WindowMode = "session",
) => {
  const window = targetWindow ?? mainWindow;
  if (!window) return;

  const workArea = resolveWorkArea(window);
  const preset = WINDOW_PRESETS[mode];
  const minWidth = Math.min(preset.minWindowWidth, workArea.width);
  const minHeight = Math.min(preset.minWindowHeight, workArea.height);

  window.setMinimumSize(
    Math.max(Math.floor(minWidth), 1),
    Math.max(Math.floor(minHeight), 1),
  );

  if (preset.fixedWidth && preset.fixedHeight) {
    window.setResizable(false);
  } else {
    window.setResizable(true);
  }
};

/**
 * Get the renderer URL for the window.
 * - Development: Vite dev server (localhost:3400)
 * - Production: app:// custom protocol serving static files
 */
function getRendererUrl(): string {
  if (isDev) {
    return DEFAULT_DEV_URL;
  }
  // Production: use app:// protocol for SPA
  // Use root path "/" instead of "/index.html" so TanStack Router matches the "/" route
  return `${APP_PROTOCOL_SCHEME}://./`;
}

const setWindowMode = (
  targetWindow: BrowserWindow | null,
  mode: WindowMode,
) => {
  const window = targetWindow ?? mainWindow;
  if (!window) return;
  const previousMode = windowModes.get(window.id);
  if (previousMode === mode) return;
  windowModes.set(window.id, mode);
  const bounds = calculateWindowBounds(window, mode);

  applyWindowConstraints(window, mode);
  window.setBounds(bounds, true);
  refreshTrayMenu();
};

async function createRendererWindow(
  runtime: RuntimeContext,
  initialMode: WindowMode = "onboarding",
) {
  const preloadPath = path.join(__dirname, "preload.js");
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const initialBounds = calculateWindowBounds(null, initialMode);
  const initialPreset = WINDOW_PRESETS[initialMode];
  const browserWindow = new BrowserWindow({
    x: initialBounds.x,
    y: initialBounds.y,
    width: initialBounds.width,
    height: initialBounds.height,
    minWidth: initialPreset.minWindowWidth,
    minHeight: initialPreset.minWindowHeight,
    resizable: !initialPreset.fixedWidth,
    show: false,
    icon: iconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  browserWindow.once("ready-to-show", () => browserWindow.show());
  applyWindowConstraints(browserWindow, initialMode);

  windowModes.set(browserWindow.id, initialMode);
  windowContexts.set(browserWindow.id, {
    runtimeId: runtime.id,
    window: browserWindow,
  });
  refreshTrayMenu();

  browserWindow.on("focus", () => {
    activeWindowId = browserWindow.id;
    refreshTrayMenu();
  });

  browserWindow.on("blur", () => {
    if (activeWindowId === browserWindow.id) {
      activeWindowId = null;
      refreshTrayMenu();
    }
  });

  browserWindow.on("closed", () => {
    const context = windowContexts.get(browserWindow.id);
    windowContexts.delete(browserWindow.id);
    windowModes.delete(browserWindow.id);
    if (context) {
      releaseRuntimeIfUnused(context.runtimeId);
    }
    if (mainWindow === browserWindow) {
      const [nextWindow] = BrowserWindow.getAllWindows();
      mainWindow = nextWindow ?? null;
    }
    if (activeWindowId === browserWindow.id) {
      activeWindowId = null;
    }
    refreshTrayMenu();
  });

  const rendererURL = getRendererUrl();

  const isRendererUrl = (targetUrl: string) => {
    if (!targetUrl) return false;
    if (targetUrl === "about:blank") {
      return true;
    }
    try {
      const parsedUrl = new URL(targetUrl);
      if (parsedUrl.protocol === "devtools:") {
        return true;
      }
      // In dev: match localhost origin; in prod: match app:// protocol
      if (isDev) {
        const rendererOrigin = new URL(rendererURL).origin;
        return parsedUrl.origin === rendererOrigin;
      }
      return parsedUrl.protocol === `${APP_PROTOCOL_SCHEME}:`;
    } catch {
      return false;
    }
  };

  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isRendererUrl(url)) {
      return { action: "allow" };
    }
    openExternalUrl(url);
    return { action: "deny" };
  });

  browserWindow.webContents.on("will-navigate", (event, url) => {
    if (isRendererUrl(url)) {
      return;
    }
    event.preventDefault();
    openExternalUrl(url);
  });

  await browserWindow.loadURL(rendererURL);

  if (isDev) {
    browserWindow.webContents.openDevTools({ mode: "detach" });
  }

  const forwardWindowState = () => sendWindowState(browserWindow);
  browserWindow.on("maximize", forwardWindowState);
  browserWindow.on("unmaximize", forwardWindowState);
  browserWindow.on("enter-full-screen", forwardWindowState);
  browserWindow.on("leave-full-screen", forwardWindowState);
  browserWindow.webContents.on("did-finish-load", () => {
    forwardWindowState();
  });

  return browserWindow;
}

function getWindowFromEvent(event: IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(event.sender);
}

function registerIpcHandlers() {
  ipcMain.handle("window:minimize", (event) => {
    const target = getWindowFromEvent(event);
    target?.minimize();
    return undefined;
  });
  ipcMain.handle("window:toggle-maximize", (event) => {
    const target = getWindowFromEvent(event);
    if (!target) return getStatePayload(null);
    if (target.isMaximized()) {
      target.unmaximize();
    } else {
      target.maximize();
    }
    return getStatePayload(target);
  });
  ipcMain.handle("window:close", (event) => {
    const target = getWindowFromEvent(event);
    target?.close();
    return undefined;
  });
  ipcMain.handle("window:get-state", (event) => {
    const target = getWindowFromEvent(event);
    return getStatePayload(target ?? null);
  });

  ipcMain.handle("desktop:select-workspace", async (event) => {
    const target = getWindowFromEvent(event);
    const runtime = getRuntimeForWindow(target);
    if (!runtime) {
      return null;
    }
    const selected = await promptForWorkspace(runtime, target ?? undefined);
    return selected ?? runtime.workspacePath;
  });

  ipcMain.handle("desktop:open-workspace-launcher", async () => {
    try {
      await openWorkspaceLauncherWindow();
    } catch (error) {
      console.error("[desktop] Failed to open workspace launcher", error);
    }
  });

  ipcMain.handle(
    "desktop:open-external",
    (_event, payload: { url?: string | null }) => {
      if (!payload?.url) {
        return;
      }
      openExternalUrl(payload.url);
    },
  );

  ipcMain.handle(
    "desktop:install-executor",
    async (_event, payload: { executor?: DesktopExecutor | null }) => {
      if (
        payload?.executor !== "CLAUDE_CODE" &&
        payload?.executor !== "CODEX"
      ) {
        throw new Error("Invalid executor install request.");
      }

      return installExecutor(payload.executor);
    },
  );

  ipcMain.handle("window:set-mode", (event, mode: WindowMode) => {
    const target = getWindowFromEvent(event);
    if (mode !== "onboarding" && mode !== "session") {
      console.warn(`[desktop] Invalid window mode: ${mode}`);
      return;
    }
    setWindowMode(target, mode);
  });

  ipcMain.handle(
    "desktop:show-file-context-menu",
    async (event, payload: { path: string; name: string }) => {
      const window = getWindowFromEvent(event);
      const menuAction = await new Promise<string | null>((resolve) => {
        const menu = Menu.buildFromTemplate([
          {
            label: "Rename",
            click: () => resolve("rename"),
          },
          { type: "separator" },
          {
            label: "Delete",
            click: () => resolve("delete"),
          },
        ]);
        menu.popup({
          window: window ?? undefined,
          callback: () => resolve(null),
        });
      });

      if (menuAction === "rename") {
        return { action: "rename" };
      }

      if (menuAction !== "delete") {
        return null;
      }

      // Show confirmation dialog
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "Delete File",
        message: `Are you sure you want to delete "${payload.name}"?`,
        detail: "This action cannot be undone.",
        buttons: ["Move to Trash", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });

      if (result.response === 0) {
        return { action: "delete", confirmed: true };
      }
      return null;
    },
  );

  ipcMain.handle(
    "desktop:show-notification",
    (_event, payload: { title: string; body?: string }) => {
      if (!Notification.isSupported()) {
        return;
      }
      const notification = new Notification({
        title: payload.title,
        body: payload.body,
      });
      notification.on("click", () => {
        const target = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
        if (target) {
          if (target.isMinimized()) {
            target.restore();
          }
          target.show();
          target.focus();
        }
      });
      const autoCloseTimer = setTimeout(() => {
        notification.close();
      }, 10_000);
      notification.once("close", () => {
        clearTimeout(autoCloseTimer);
      });
      notification.show();
    },
  );

  ipcMain.on("desktop:get-runtime-info", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const runtime = getRuntimeForWindow(window);
    event.returnValue = runtime
      ? {
          runtimeId: runtime.id,
          backendUrl: runtime.baseUrl,
          workspacePath: runtime.workspacePath,
          platform: process.platform,
        }
      : {
          runtimeId: null,
          backendUrl: DEFAULT_DEV_URL,
          workspacePath: null,
          platform: process.platform,
        };
  });

  ipcMain.handle("app:get-version", () => {
    return app.getVersion();
  });

  ipcMain.handle("update:check", async () => {
    if (isDev) {
      return { status: "dev-mode" };
    }
    if (!isAutoUpdaterEnabled) {
      return {
        status: "error",
        error: "Auto-updater is disabled.",
      };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return { status: "checked", updateInfo: result?.updateInfo ?? null };
    } catch (error) {
      console.error("[desktop] Failed to check for updates", error);
      return {
        status: "error",
        error: toUserFacingUpdateErrorMessage(
          error,
          "Failed to check for updates.",
        ),
      };
    }
  });

  ipcMain.handle("update:download", async () => {
    if (isDev) {
      return { status: "dev-mode" };
    }
    if (!isAutoUpdaterEnabled) {
      return {
        status: "error",
        error: "Auto-updater is disabled.",
      };
    }
    try {
      await autoUpdater.downloadUpdate();
      return { status: "downloading" };
    } catch (error) {
      console.error("[desktop] Failed to download update", error);
      return {
        status: "error",
        error: toUserFacingUpdateErrorMessage(
          error,
          "Failed to download the update.",
        ),
      };
    }
  });

  ipcMain.handle("update:install", () => {
    if (isDev || !isAutoUpdaterEnabled) {
      return;
    }
    autoUpdater.quitAndInstall(false, true);
  });
}

type UpdateStatus =
  | { type: "checking" }
  | { type: "available"; version: string; releaseNotes?: string | null }
  | { type: "not-available"; version: string }
  | { type: "downloading"; percent: number }
  | { type: "downloaded"; version: string }
  | { type: "error"; message: string };

const broadcastUpdateStatus = (status: UpdateStatus) => {
  sendToRenderer(UPDATE_STATUS_CHANNEL, status);
};

function toUserFacingUpdateErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");

  if (/zip file not provided/i.test(rawMessage)) {
    return "This release is missing the macOS update package. Install from DMG or wait for the next release.";
  }

  if (
    /code signature .*did not pass validation/i.test(rawMessage) ||
    /code failed to satisfy specified code requirement/i.test(rawMessage)
  ) {
    return "The downloaded update failed signature validation. Reinstall from the latest DMG.";
  }

  return fallback;
}

function setupAutoUpdater() {
  if (isDev) {
    console.log("[desktop] Skipping auto-updater setup in dev mode");
    return;
  }
  if (!isAutoUpdaterEnabled) {
    console.log(
      "[desktop] Auto-updater is disabled (set CHRO_ENABLE_AUTO_UPDATER=1 to enable)",
    );
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[desktop] Checking for updates...");
    broadcastUpdateStatus({ type: "checking" });
  });

  autoUpdater.on("update-available", (info: UpdateInfo) => {
    console.log(`[desktop] Update available: ${info.version}`);
    const releaseNotes =
      typeof info.releaseNotes === "string"
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((n) => n.note).join("\n")
          : null;
    broadcastUpdateStatus({
      type: "available",
      version: info.version,
      releaseNotes,
    });
  });

  autoUpdater.on("update-not-available", (info: UpdateInfo) => {
    console.log(`[desktop] No update available (current: ${info.version})`);
    broadcastUpdateStatus({ type: "not-available", version: info.version });
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[desktop] Download progress: ${progress.percent.toFixed(1)}%`);
    broadcastUpdateStatus({ type: "downloading", percent: progress.percent });
  });

  autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
    console.log(`[desktop] Update downloaded: ${info.version}`);
    broadcastUpdateStatus({ type: "downloaded", version: info.version });
  });

  autoUpdater.on("error", (error) => {
    console.error("[desktop] Auto-updater error:", error);
    broadcastUpdateStatus({
      type: "error",
      message: toUserFacingUpdateErrorMessage(
        error,
        "Failed to update. Please try again later.",
      ),
    });
  });

  // Check for updates after a short delay to not block startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((error) => {
      console.warn("[desktop] Initial update check failed:", error);
    });
  }, 3000);
}

async function bootstrap() {
  await app.whenReady();

  // Register app:// protocol handler for production SPA
  if (!isDev) {
    const distDir = resolveDistDir();
    registerAppProtocolHandler(distDir);
  }

  primaryRuntimeDir = path.join(userDataDir, "chro");
  registerIpcHandlers();
  setupAutoUpdater();

  const primaryRuntime = await prepareRuntime(primaryRuntimeDir, true);
  mainWindow = await createRendererWindow(primaryRuntime, "onboarding");
  initTray(() => mainWindow, describeWorkspaceWindows);
  syncTrayState("connected");

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const runtimeDir = primaryRuntimeDir ?? path.join(userDataDir, "chro");
      const runtime = await prepareRuntime(runtimeDir, true);
      mainWindow = await createRendererWindow(runtime, "onboarding");
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  for (const [runtimeId, runtime] of runtimeContexts) {
    console.log(`[desktop] Stopping runtime ${runtimeId}`);
    runtime.process.kill();
  }
});

app.on("will-quit", () => {
  for (const runtime of runtimeContexts.values()) {
    runtime.sessionDatabase.close();
  }
  runtimeContexts.clear();
  destroyTray();
});

bootstrap().catch((error) => {
  console.error("Failed to bootstrap desktop app", error);
  app.quit();
});
