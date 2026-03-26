import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";

type TrayStatus = "connected" | "waiting" | "error";

interface TrayState {
  taskCount: number;
  status: TrayStatus;
}

export type TrayWorkspaceWindow = {
  windowId: number;
  label: string;
  workspacePath: string | null;
  description: string | null;
  mode: "onboarding" | "session";
  isFocused: boolean;
};

type WorkspaceResolver = () => TrayWorkspaceWindow[];

const CANVAS_SIZE = 36; // draw high-res then downscale
const OUTPUT_SIZE = 18;
const BADGE_DIAMETER = 18;
const BADGE_CENTER_OFFSET = 4;

let tray: Tray | null = null;
let windowResolver: (() => BrowserWindow | null) | null = null;
let lastState: TrayState = { taskCount: 0, status: "connected" };
let ipcRegistered = false;
let workspaceResolver: WorkspaceResolver | null = null;

function resolveBaseIcon(): NativeImage | null {
  const candidate = path.join(
    app.getAppPath(),
    "assets",
    "tray",
    process.platform === "darwin" ? "trayTemplate.png" : "tray.png",
  );

  const image = nativeImage.createFromPath(candidate);
  return image.isEmpty() ? null : image;
}

const baseIcon = resolveBaseIcon();
const baseIconDataUrl = (() => {
  if (!baseIcon) return null;
  try {
    const raster =
      process.platform === "darwin"
        ? baseIcon.resize({
            width: CANVAS_SIZE,
            height: CANVAS_SIZE,
            quality: "best",
          })
        : baseIcon.resize({ width: CANVAS_SIZE, height: CANVAS_SIZE });
    return `data:image/png;base64,${raster.toPNG().toString("base64")}`;
  } catch {
    return null;
  }
})();

const embeddedFontDataUrl = (() => {
  try {
    const fontPath = path.join(
      app.getAppPath(),
      "assets",
      "fonts",
      "NotoSansJP-Regular.otf",
    );
    const fontBuffer = readFileSync(fontPath);
    return `data:font/otf;base64,${fontBuffer.toString("base64")}`;
  } catch {
    return null;
  }
})();

function renderTraySvg(state: TrayState): string {
  const baseLayer = baseIconDataUrl
    ? `<image href="${baseIconDataUrl}" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" />`
    : `<rect width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" rx="8" fill="#1b1b1f" />`;

  if (state.taskCount <= 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}">
  ${baseLayer}
</svg>`;
  }

  const fill = (() => {
    switch (state.status) {
      case "connected":
        return "#3ed470";
      case "waiting":
        return "#f5c044";
      case "error":
        return "#ff5a5a";
    }
  })();

  const centerX = CANVAS_SIZE - BADGE_DIAMETER / 2 + BADGE_CENTER_OFFSET;
  const centerY = BADGE_DIAMETER / 2 - BADGE_CENTER_OFFSET;
  const label =
    state.taskCount > 999
      ? "1k+"
      : state.taskCount > 99
        ? "99+"
        : state.taskCount.toString();
  const fontFaceRule = embeddedFontDataUrl
    ? `@font-face { font-family: \"ChroTray\"; src: url('${embeddedFontDataUrl}') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}">
  <defs>
    <style>
      ${fontFaceRule}
      .badge-label { font-family: \"ChroTray\", \"SF Pro Display\", \"Segoe UI\", sans-serif; font-size: 16px; font-weight: 600; }
    </style>
  </defs>
  ${baseLayer}
  <g>
    <circle cx="${centerX}" cy="${centerY}" r="${BADGE_DIAMETER / 2}" fill="${fill}" />
    <text x="${centerX}" y="${centerY + 1}" text-anchor="middle" dominant-baseline="middle" fill="#ffffff" class="badge-label">${label}</text>
  </g>
</svg>`;
}

function drawIcon(state: TrayState): NativeImage {
  const isMac = process.platform === "darwin";

  try {
    const svg = renderTraySvg(state);
    const raw = nativeImage.createFromBuffer(Buffer.from(svg, "utf8"), {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      scaleFactor: 1,
    });
    if (!raw.isEmpty()) {
      const resized = raw.resize({
        width: OUTPUT_SIZE,
        height: OUTPUT_SIZE,
        quality: "best",
      });
      if (isMac) {
        resized.setTemplateImage(true);
      }
      return resized;
    }
  } catch (error) {
    console.warn("[desktop] Failed to render tray icon from SVG", error);
  }

  if (baseIcon) {
    const resized = baseIcon.resize({
      width: OUTPUT_SIZE,
      height: OUTPUT_SIZE,
      quality: "best",
    });
    if (isMac) {
      resized.setTemplateImage(true);
    }
    return resized;
  }

  const fallbackSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" viewBox="0 0 ${CANVAS_SIZE} ${CANVAS_SIZE}">
  <rect width="${CANVAS_SIZE}" height="${CANVAS_SIZE}" rx="8" fill="#1b1b1f" />
</svg>`;
  const fallback = nativeImage.createFromBuffer(
    Buffer.from(fallbackSvg, "utf8"),
    {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      scaleFactor: 1,
    },
  );
  const resized = fallback.resize({
    width: OUTPUT_SIZE,
    height: OUTPUT_SIZE,
    quality: "best",
  });
  if (isMac) {
    resized.setTemplateImage(true);
  }
  return resized;
}

function applyTrayState(patch: Partial<TrayState>) {
  if (!tray) return;
  lastState = { ...lastState, ...patch };
  const icon = drawIcon(lastState);
  tray.setImage(icon);

  const tooltip =
    lastState.taskCount > 0
      ? `Agent タスク実行中: ${lastState.taskCount} 件`
      : "Agent タスクは実行中なし";

  tray.setToolTip(tooltip);
}

const resolveWorkspaceEntries = () =>
  workspaceResolver ? workspaceResolver() : [];

function focusBrowserWindow(target: BrowserWindow | null) {
  if (!target || target.isDestroyed()) return;
  if (target.isMinimized()) {
    target.restore();
  }
  if (!target.isVisible()) {
    target.show();
  }
  target.focus();
}

const focusWorkspaceWindow = (windowId: number) => {
  let target: BrowserWindow | null = null;
  try {
    target = BrowserWindow.fromId(windowId);
  } catch {
    target = null;
  }
  focusBrowserWindow(target);
};

const buildWorkspaceMenuItems = (): MenuItemConstructorOptions[] => {
  const entries = resolveWorkspaceEntries();
  if (entries.length === 0) {
    return [
      {
        label: "No workspace windows",
        enabled: false,
      },
    ];
  }

  return entries.map((entry) => {
    const sublabel = entry.workspacePath ?? entry.description ?? undefined;
    return {
      label: entry.label,
      type: "radio",
      checked: entry.isFocused,
      sublabel,
      click: () => {
        focusWorkspaceWindow(entry.windowId);
        refreshTrayMenu();
      },
    } satisfies MenuItemConstructorOptions;
  });
};

const buildTrayMenuTemplate = (): MenuItemConstructorOptions[] => {
  const workspaceItems = buildWorkspaceMenuItems();
  const template: MenuItemConstructorOptions[] = [...workspaceItems];

  template.push({ type: "separator" });
  template.push({
    label: "Exit Chro",
    click: () => app.quit(),
  });

  return template;
};

const buildTrayMenu = () => Menu.buildFromTemplate(buildTrayMenuTemplate());

function refreshTrayContextMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

export function refreshTrayMenu() {
  refreshTrayContextMenu();
}

const showWorkspaceMenu = () => {
  if (!tray) return;
  const menu = buildTrayMenu();
  tray.setContextMenu(menu);
  tray.popUpContextMenu(menu);
};

const focusPrimaryWindow = () => {
  if (!windowResolver) return;
  const win = windowResolver();
  focusBrowserWindow(win ?? null);
};

export function initTray(
  getWindow: () => BrowserWindow | null,
  resolveWorkspaces: WorkspaceResolver = () => [],
) {
  if (tray) return;

  tray = new Tray(drawIcon(lastState));
  windowResolver = getWindow;
  workspaceResolver = resolveWorkspaces;

  refreshTrayContextMenu();

  tray.on("click", () => {
    const workspaceEntries = resolveWorkspaceEntries();
    if (workspaceEntries.length > 1) {
      showWorkspaceMenu();
      return;
    }
    focusPrimaryWindow();
  });

  tray.on("right-click", () => {
    showWorkspaceMenu();
  });

  if (!ipcRegistered) {
    ipcRegistered = true;
    ipcMain.handle("tray:update", (_event, payload: Partial<TrayState>) => {
      applyTrayState(payload);
    });
  }
}

export function destroyTray() {
  if (ipcRegistered) {
    ipcRegistered = false;
    ipcMain.removeHandler("tray:update");
  }

  if (tray) {
    tray.destroy();
    tray = null;
  }
  windowResolver = null;
  workspaceResolver = null;
}

export function updateTrayState(state: Partial<TrayState>) {
  applyTrayState(state);
}

export function getTrayState(): TrayState {
  return { ...lastState };
}
