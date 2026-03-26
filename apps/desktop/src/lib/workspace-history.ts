import { getUiValue, setUiValue } from "./ui-state-client";

export type RecentWorkspace = {
  path: string;
  lastOpenedAt: number;
};

const STORAGE_KEY = "chro.recentWorkspaces";
const MAX_RECENT_WORKSPACES = 5;

export const normalizePathForCompare = (input: string): string => {
  const normalized = input.trim().replace(/\\+/g, "/").replace(/\/+/g, "/");
  if (/^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/$/, "");
};

const readFromStorage = (): RecentWorkspace[] => {
  const raw = getUiValue<RecentWorkspace[]>(STORAGE_KEY);
  if (!raw || !Array.isArray(raw)) return [];
  return raw
    .filter(
      (entry): entry is RecentWorkspace =>
        Boolean(entry) &&
        typeof entry.path === "string" &&
        typeof entry.lastOpenedAt === "number",
    )
    .slice(0, MAX_RECENT_WORKSPACES);
};

const persist = (entries: RecentWorkspace[]): RecentWorkspace[] => {
  const trimmed = entries.slice(0, MAX_RECENT_WORKSPACES);
  setUiValue(STORAGE_KEY, trimmed);
  return trimmed;
};

export const getRecentWorkspaces = (): RecentWorkspace[] => {
  return readFromStorage();
};

export const touchRecentWorkspace = (path: string): RecentWorkspace[] => {
  const trimmed = path.trim();
  if (!trimmed) {
    return getRecentWorkspaces();
  }

  const normalized = normalizePathForCompare(trimmed);
  const existing = readFromStorage().filter(
    (entry) => normalizePathForCompare(entry.path) !== normalized,
  );
  const next: RecentWorkspace[] = [
    {
      path: trimmed,
      lastOpenedAt: Date.now(),
    },
    ...existing,
  ].slice(0, MAX_RECENT_WORKSPACES);

  return persist(next);
};

