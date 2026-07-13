/**
 * Recent search history for the file-search pane, persisted in localStorage.
 * Most-recent first, de-duplicated, capped. Mirrors Obsidian's search history
 * shown when the search box is focused.
 */

const STORAGE_KEY = "chro:search-history";
const MAX_ENTRIES = 10;

function read(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function write(entries: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore quota/serialization errors: history is best-effort.
  }
}

export function loadSearchHistory(): string[] {
  return read();
}

/** Record a search, moving it to the front; returns the updated list. */
export function pushSearchHistory(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return read();
  const next = [trimmed, ...read().filter((e) => e !== trimmed)].slice(
    0,
    MAX_ENTRIES,
  );
  write(next);
  return next;
}

export function clearSearchHistory(): void {
  write([]);
}
