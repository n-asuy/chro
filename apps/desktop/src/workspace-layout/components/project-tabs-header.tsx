import { useOptionalProjectContext } from "@/files/context/project-context";
import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import { useOptionalProjectTasks } from "@/session/context/project-tasks-context";
import { useSettingsModal } from "@/settings/components/settings-modal-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { toast } from "@chro/ui/hooks/use-toast";
import {
  Check,
  ChevronDown,
  Copy,
  PanelLeft,
  PanelRight,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useDockStore } from "../state/dock-store";
import { useRightDockStore } from "../state/right-dock-store";
import { OpenInAppIcon, type OpenInIconId } from "./open-in-app-icon";

const isDarwin = (): boolean =>
  typeof window !== "undefined" &&
  (window.__CHRO_RUNTIME__?.platform === "darwin" ||
    navigator.platform.toLowerCase().includes("mac"));

const OPEN_IN_APP_IDS = [
  "file-manager",
  "cursor",
  "zed",
  "terminal",
  "iterm2",
  "powershell",
] as const;

type OpenInAppId = (typeof OPEN_IN_APP_IDS)[number];

type OpenInOption = {
  id: OpenInAppId;
  label: string;
  with?: string;
  icon: OpenInIconId;
};

const OPEN_IN_APP_STORAGE_KEY = "workspace-layout:open-in-app:v1";

const isOpenInAppId = (value: string | null): value is OpenInAppId =>
  OPEN_IN_APP_IDS.includes(value as OpenInAppId);

const readStoredOpenInAppId = (): OpenInAppId => {
  if (typeof window === "undefined") return "file-manager";
  try {
    const value = window.localStorage.getItem(OPEN_IN_APP_STORAGE_KEY);
    return isOpenInAppId(value) ? value : "file-manager";
  } catch {
    return "file-manager";
  }
};

const writeStoredOpenInAppId = (id: OpenInAppId) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OPEN_IN_APP_STORAGE_KEY, id);
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
};

const runtimePlatform = (): "darwin" | "win32" | "linux" | "unknown" => {
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

const openInOptions = (): OpenInOption[] => {
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
  ];

  if (platform === "darwin") {
    return [
      { id: "file-manager", label: fileManager, icon: fileManagerIcon },
      ...editorOptions,
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

const getOpenInErrorDescription = (
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

/**
 * Slim window chrome bar. Project switching lives in the left-dock project tree
 * (see ProjectsDockPanel), so this bar carries the left-dock toggle (just past
 * the traffic lights), the global Settings entry, and the right-dock toggle. It
 * reserves the macOS traffic-light inset and serves as the window drag region.
 *
 * Dragging is driven by Tauri's `data-tauri-drag-region` attribute: Tauri only
 * starts a window drag when the moused-down element *itself* carries the
 * attribute, so every non-interactive region opts in explicitly while the
 * buttons stay clickable by omitting it. (The old `-webkit-app-region` CSS is
 * an Electron-only feature and is a no-op under Tauri's WebView.)
 */
export function ProjectTabsHeader() {
  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-8 shrink-0 items-center gap-1",
        // Reserve space for the traffic lights on macOS (Overlay title bar).
        // Windows/Linux use a native title bar, so just a small inset.
        isDarwin() ? "pl-20" : "pl-2",
        "pr-2",
      )}
    >
      <LeftSidebarToggle />
      <div data-tauri-drag-region className="min-w-0 flex-1" />
      <OpenInMenu />
      <SettingsToggle />
      <RightSidebarToggle />
      {/* Trailing drag handle so the window can still be moved on macOS
          (Overlay title bar) even when the bar is otherwise full. */}
      <div data-tauri-drag-region className="h-full w-3 shrink-0" />
    </div>
  );
}

function OpenInMenu() {
  const project = useOptionalProjectContext();
  const workspacePath = project?.workspacePath ?? null;
  const [selectedAppId, setSelectedAppId] = useState<OpenInAppId>(
    readStoredOpenInAppId,
  );
  const canOpen =
    typeof window !== "undefined" &&
    Boolean(workspacePath && window.desktop?.openPath);
  const options = openInOptions();
  const selectedOption =
    options.find((option) => option.id === selectedAppId) ?? options[0];

  useEffect(() => {
    if (!selectedOption || selectedOption.id === selectedAppId) return;
    setSelectedAppId(selectedOption.id);
    writeStoredOpenInAppId(selectedOption.id);
  }, [selectedOption, selectedAppId]);

  const selectOption = useCallback((option: OpenInOption) => {
    setSelectedAppId(option.id);
    writeStoredOpenInAppId(option.id);
  }, []);

  const copyPath = useCallback(async () => {
    if (!workspacePath) return;
    try {
      await navigator.clipboard.writeText(workspacePath);
      toast({
        variant: "success",
        title: "Project path copied",
        description: workspacePath,
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Could not copy path",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [workspacePath]);

  const openIn = useCallback(
    async (option: OpenInOption) => {
      if (!workspacePath) return;
      const openPath = window.desktop?.openPath;
      if (!openPath) {
        toast({
          variant: "destructive",
          title: "Cannot open project",
          description: "Open in is available in the desktop app.",
        });
        return;
      }

      try {
        await openPath(workspacePath, option.with);
      } catch (error) {
        console.warn("[open-in] failed", {
          app: option.label,
          with: option.with,
          workspacePath,
          error,
        });
        toast({
          title: `Could not open in ${option.label}`,
          description: getOpenInErrorDescription(option.label, error),
        });
      }
    },
    [workspacePath],
  );

  if (!workspacePath || !selectedOption) return null;

  return (
    <div className="ml-1 inline-flex h-6 shrink-0 items-center overflow-hidden rounded-md">
      <button
        type="button"
        title={`Open in ${selectedOption.label}`}
        aria-label={`Open project in ${selectedOption.label}`}
        disabled={!canOpen}
        onClick={() => {
          void openIn(selectedOption);
        }}
        className={cn(
          "inline-flex h-6 w-7 shrink-0 items-center justify-center rounded-l-md",
          "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        <OpenInAppIcon id={selectedOption.icon} className="h-4 w-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Choose Open in app"
            aria-label="Choose Open in app"
            className={cn(
              "inline-flex h-6 w-5 shrink-0 items-center justify-center rounded-r-md border-l border-foreground/10",
              "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            <ChevronDown className="h-3 w-3 opacity-70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-48">
          <DropdownMenuLabel className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            Open in
          </DropdownMenuLabel>
          {options.map((option) => {
            const selected = option.id === selectedOption.id;
            return (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => {
                  selectOption(option);
                  if (canOpen) void openIn(option);
                }}
                className="gap-2 text-[12px]"
              >
                <OpenInAppIcon id={option.icon} className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selected ? (
                  <Check className="h-3.5 w-3.5 text-muted-foreground" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void copyPath();
            }}
            className="gap-2 text-[12px]"
          >
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            <span>Copy path</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Open/close toggle for the left dock, mounted at the left edge of the header
 * just past the macOS traffic-light inset. Lives here (not inside the panel)
 * so closing the dock hides it entirely instead of leaving a collapsed rail —
 * and so the dock can still be reopened once it's gone. Carries the running
 * session badge that the old collapsed rail used to show.
 */
function LeftSidebarToggle() {
  const { t } = useLanguage();
  const collapsed = useDockStore((s) => s.collapsed);
  const toggleCollapsed = useDockStore((s) => s.toggleCollapsed);
  const runningCount = useOptionalProjectTasks()?.runningCount ?? 0;

  const open = !collapsed;
  const label = open ? t("closeSidebar") : t("openSidebar");

  return (
    <button
      type="button"
      onClick={toggleCollapsed}
      title={label}
      aria-label={label}
      aria-pressed={open}
      className={cn(
        "relative ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        open && "text-foreground",
      )}
    >
      <PanelLeft className="h-3.5 w-3.5" />
      {!open && runningCount > 0 ? (
        <span
          aria-label={`${runningCount} running`}
          className={cn(
            "pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-3.5",
            "items-center justify-center rounded-full bg-primary px-1",
            "text-[9px] font-medium leading-none text-primary-foreground",
            "ring-2 ring-background",
          )}
        >
          {runningCount > 99 ? "99+" : runningCount}
        </span>
      ) : null}
    </button>
  );
}

function SettingsToggle() {
  const settings = useSettingsModal();
  return (
    <button
      type="button"
      onClick={settings.open}
      title="Settings"
      aria-label="Settings"
      className={cn(
        "ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      <Settings className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Single open/close toggle for the right dock, mounted at the right edge
 * of the header. Re-opens the dock on its last active panel; if the dock
 * has never been opened in this project, defaults to "filetree".
 */
function RightSidebarToggle() {
  const collapsed = useRightDockStore((s) => s.collapsed);
  const activePanel = useRightDockStore((s) => s.activePanel);
  const setActivePanel = useRightDockStore((s) => s.setActivePanel);
  const setCollapsed = useRightDockStore((s) => s.setCollapsed);

  const open = !collapsed && activePanel !== null;

  const handleClick = useCallback(() => {
    if (open) {
      setCollapsed(true);
      return;
    }
    if (activePanel === null) {
      setActivePanel("filetree");
    } else {
      setCollapsed(false);
    }
  }, [open, activePanel, setActivePanel, setCollapsed]);

  return (
    <button
      type="button"
      onClick={handleClick}
      title={open ? "Close right panel" : "Open right panel"}
      aria-label={open ? "Close right panel" : "Open right panel"}
      aria-pressed={open}
      className={cn(
        "ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
        "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        open && "text-foreground",
      )}
    >
      <PanelRight className="h-3.5 w-3.5" />
    </button>
  );
}
