import {
  FileDiff,
  FileText,
  Globe,
  type LucideIcon,
  MessagesSquare,
  MonitorPlay,
  Settings,
  Terminal,
} from "lucide-react";
import { getPaneItem } from "../registry/registry";
import type { Tab } from "../types";

export function iconForKind(tab: Tab): LucideIcon | null {
  const desc = getPaneItem(tab.kind.type);
  const name = tab.iconName ?? desc?.iconName;
  switch (name) {
    case "messages-square":
      return MessagesSquare;
    case "file":
      return FileText;
    case "diff":
      return FileDiff;
    case "settings":
      return Settings;
    case "terminal":
      return Terminal;
    case "globe":
      return Globe;
    case "monitor-play":
      return MonitorPlay;
    default:
      return defaultIconForKind(tab);
  }
}

function defaultIconForKind(tab: Tab): LucideIcon | null {
  switch (tab.kind.type) {
    case "session":
      return MessagesSquare;
    case "file":
      return FileText;
    case "diff":
      return FileDiff;
    case "settings":
      return Settings;
    case "terminal":
      return Terminal;
    case "browser":
      return Globe;
    case "cdp-browser":
      return MonitorPlay;
  }
}

export function titleForTab(tab: Tab): string {
  const desc = getPaneItem(tab.kind.type);
  const resolved = desc?.resolveTitle?.(tab.kind);
  return resolved ?? tab.title;
}
