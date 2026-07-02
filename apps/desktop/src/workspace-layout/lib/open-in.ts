export type OpenInIconId =
  | "cmux"
  | "cursor"
  | "file-explorer"
  | "finder"
  | "ghostty"
  | "iterm2"
  | "obsidian"
  | "powershell"
  | "terminal"
  | "vscode"
  | "zed";

const OPEN_IN_APP_IDS = [
  "file-manager",
  "cursor",
  "zed",
  "obsidian",
  "cmux",
  "terminal",
  "iterm2",
  "powershell",
] as const;

export type OpenInAppId = (typeof OPEN_IN_APP_IDS)[number];

export type OpenInOption = {
  id: OpenInAppId;
  label: string;
  with?: string;
  icon: OpenInIconId;
};

const OPEN_IN_APP_STORAGE_KEY = "workspace-layout:open-in-app:v1";

const isOpenInAppId = (value: string | null): value is OpenInAppId =>
  OPEN_IN_APP_IDS.includes(value as OpenInAppId);

export const readStoredOpenInAppId = (): OpenInAppId => {
  if (typeof window === "undefined") return "file-manager";
  try {
    const value = window.localStorage.getItem(OPEN_IN_APP_STORAGE_KEY);
    return isOpenInAppId(value) ? value : "file-manager";
  } catch {
    return "file-manager";
  }
};

export const writeStoredOpenInAppId = (id: OpenInAppId) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OPEN_IN_APP_STORAGE_KEY, id);
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
};

export const runtimePlatform = (): "darwin" | "win32" | "linux" | "unknown" => {
  if (typeof window === "undefined") return "unknown";
  const runtime = window.__CHRO_RUNTIME__?.platform;
  if (runtime === "darwin" || runtime === "win32" || runtime === "linux") {
    return runtime;
  }

  const value = navigator.platform.toLowerCase();
  if (value.includes("mac")) return "darwin";
  if (value.includes("win")) return "win32";
  if (value.includes("linux")) return "linux";
  return "unknown";
};

export const getOpenInOptions = (): OpenInOption[] => {
  const platform = runtimePlatform();
  const fileManager =
    platform === "darwin"
      ? "Finder"
      : platform === "win32"
        ? "File Explorer"
        : "File Manager";
  const fileManagerIcon = platform === "darwin" ? "finder" : "file-explorer";
  const editorOptions: OpenInOption[] = [
    {
      id: "cursor",
      label: "Cursor",
      with: platform === "darwin" ? "Cursor" : "cursor",
      icon: "cursor",
    },
    {
      id: "zed",
      label: "Zed",
      with: platform === "darwin" ? "Zed" : "zed",
      icon: "zed",
    },
    // Obsidian registers the `obsidian://` URL scheme but not a folder document
    // type, so handing it the workspace via LaunchServices/`open -a` only raises
    // its last vault. We route through its URI instead (see
    // openWorkspaceWithOption), which is also cross-platform, so it carries no
    // `with` app name.
    {
      id: "obsidian",
      label: "Obsidian",
      icon: "obsidian",
    },
  ];

  if (platform === "darwin") {
    return [
      { id: "file-manager", label: fileManager, icon: fileManagerIcon },
      ...editorOptions,
      // cmux is a macOS-only native app. We hand the workspace to its own
      // `cmux open <path>` CLI (see the open_in_cmux Tauri command) instead of
      // LaunchServices, so it works regardless of how cmux was launched.
      { id: "cmux", label: "cmux", icon: "cmux" },
      { id: "terminal", label: "Terminal", with: "Terminal", icon: "terminal" },
      { id: "iterm2", label: "iTerm2", with: "iTerm", icon: "iterm2" },
    ];
  }

  if (platform === "win32") {
    return [
      { id: "file-manager", label: fileManager, icon: fileManagerIcon },
      ...editorOptions,
      {
        id: "powershell",
        label: "PowerShell",
        with: "powershell",
        icon: "powershell",
      },
    ];
  }

  return [
    { id: "file-manager", label: fileManager, icon: fileManagerIcon },
    ...editorOptions,
  ];
};

export const getSelectedOpenInOption = (): OpenInOption | null => {
  const options = getOpenInOptions();
  if (options.length === 0) return null;
  const selectedAppId = readStoredOpenInAppId();
  return options.find((option) => option.id === selectedAppId) ?? options[0];
};

// Hand `workspacePath` to Obsidian as a vault through its `obsidian://` URI
// rather than LaunchServices. The `path` parameter takes an absolute filesystem
// path and Obsidian resolves it to the owning vault.
const buildObsidianUri = (workspacePath: string): string =>
  `obsidian://open?path=${encodeURIComponent(workspacePath)}`;

export const canOpenWorkspaceWithOption = (
  workspacePath: string | null | undefined,
  option: OpenInOption | null | undefined,
): boolean => {
  if (typeof window === "undefined" || !workspacePath || !option) return false;
  if (option.id === "cmux") return Boolean(window.desktop?.openInCmux);
  if (option.id === "obsidian") return Boolean(window.desktop?.openExternalUrl);
  return Boolean(window.desktop?.openPath);
};

export const openWorkspaceWithOption = async (
  workspacePath: string,
  option: OpenInOption,
): Promise<void> => {
  const desktop = typeof window === "undefined" ? undefined : window.desktop;

  if (option.id === "cmux") {
    const openInCmux = desktop?.openInCmux;
    if (!openInCmux) {
      throw new Error("Open in is available in the desktop app.");
    }
    await openInCmux(workspacePath);
    return;
  }

  if (option.id === "obsidian") {
    const openExternalUrl = desktop?.openExternalUrl;
    if (!openExternalUrl) {
      throw new Error("Open in is available in the desktop app.");
    }
    await openExternalUrl(buildObsidianUri(workspacePath));
    return;
  }

  const openPath = desktop?.openPath;
  if (!openPath) {
    throw new Error("Open in is available in the desktop app.");
  }
  await openPath(workspacePath, option.with);
};

export const openWorkspaceInSelectedApp = async (
  workspacePath: string,
): Promise<OpenInOption> => {
  const option = getSelectedOpenInOption();
  if (!option) {
    throw new Error("No Open in app is available.");
  }
  await openWorkspaceWithOption(workspacePath, option);
  return option;
};

export const getOpenInErrorDescription = (
  appLabel: string,
  error: unknown,
): string => {
  const message = error instanceof Error ? error.message : String(error);
  const systemLabel = runtimePlatform() === "darwin" ? "macOS" : "The system";
  if (message.includes("ExitStatus") || message.includes("failed with")) {
    return `${systemLabel} could not hand this project folder to ${appLabel}. Open it from ${appLabel} directly.`;
  }

  return message.length > 180 ? `${message.slice(0, 177)}...` : message;
};
