import { registerPaneItem } from "./registry";
import {
  CdpBrowserTabBody,
  DiffTabBody,
  FileTabBody,
  GalleryTabBody,
  InBrowserTabBody,
  OverviewTabBody,
  ProjectDiffTabBody,
  SessionTabBody,
  SettingsTabBody,
  SkillsTabBody,
} from "./tab-bodies";

let initialized = false;

/**
 * Idempotent registration of all built-in TabKind renderers. Called once
 * from the app bootstrap; safe to invoke multiple times under HMR.
 */
export function ensurePaneItemsRegistered(): void {
  if (initialized) return;
  initialized = true;

  registerPaneItem({
    type: "overview",
    iconName: "house",
    Content: OverviewTabBody,
    resolveTitle: () => "Home",
  });

  registerPaneItem({
    type: "session",
    iconName: "messages-square",
    Content: SessionTabBody,
    resolveTitle: (kind) => {
      if (kind.type !== "session") return undefined;
      if (!kind.taskId) return "New session";
      // For task-bound sessions, fall back to `tab.title` which is kept in
      // sync with the user-entered task title by `useSessionTabTitleSync`.
      return undefined;
    },
  });

  registerPaneItem({
    type: "file",
    iconName: "file",
    Content: FileTabBody,
    resolveTitle: (kind) => {
      if (kind.type !== "file") return undefined;
      return kind.path.split("/").pop() ?? kind.path;
    },
  });

  registerPaneItem({
    type: "diff",
    iconName: "diff",
    Content: DiffTabBody,
    resolveTitle: (kind) => (kind.type === "diff" ? "Diff" : undefined),
  });

  registerPaneItem({
    type: "project-diff",
    iconName: "diff",
    Content: ProjectDiffTabBody,
    resolveTitle: () => "Working changes",
  });

  registerPaneItem({
    type: "browser",
    iconName: "globe",
    Content: InBrowserTabBody,
    resolveTitle: () => "Browser",
  });

  registerPaneItem({
    type: "cdp-browser",
    iconName: "monitor-play",
    Content: CdpBrowserTabBody,
    resolveTitle: () => "CDP Browser",
  });

  registerPaneItem({
    type: "settings",
    iconName: "settings",
    Content: SettingsTabBody,
    resolveTitle: () => "Settings",
  });

  registerPaneItem({
    type: "skills",
    iconName: "book-open",
    Content: SkillsTabBody,
    resolveTitle: () => "Skills",
  });

  registerPaneItem({
    type: "gallery",
    iconName: "image",
    Content: GalleryTabBody,
    resolveTitle: () => "Gallery",
  });
}
