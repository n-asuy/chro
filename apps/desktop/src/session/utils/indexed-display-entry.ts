import type { DisplayEntry } from "../types";

type IndexedEntryOperation = "add" | "replace" | "remove";

type ApplyIndexedEntryOperationOptions = {
  entries: DisplayEntry[];
  scope: string;
  serverIndex: number;
  operation: IndexedEntryOperation;
  createEntry?: (existing: DisplayEntry | undefined) => DisplayEntry | null;
};

const STREAM_ENTRY_KEY_MARKER = ":stream-entry:";

const streamEntryKey = (scope: string, serverIndex: number): string =>
  `${scope}${STREAM_ENTRY_KEY_MARKER}${serverIndex}`;

const serverIndexFromEntry = (
  entry: DisplayEntry,
  scope: string,
): number | null => {
  const prefix = `${scope}${STREAM_ENTRY_KEY_MARKER}`;
  if (!entry.key.startsWith(prefix)) return null;

  const value = entry.key.slice(prefix.length);
  if (!/^\d+$/.test(value)) return null;

  const index = Number.parseInt(value, 10);
  return Number.isSafeInteger(index) ? index : null;
};

/**
 * Apply an `/entries/N` operation without assuming that the local array is
 * dense from index zero.
 *
 * Active run history is bounded, so a reconnect can legitimately begin with a
 * `replace /entries/N` after the original `add` (and lower indices) have been
 * evicted. Mapping the server index to a stable key lets that replace act as an
 * upsert and makes every later cumulative update target the same display row.
 */
export function applyIndexedDisplayEntryOperation({
  entries,
  scope,
  serverIndex,
  operation,
  createEntry,
}: ApplyIndexedEntryOperationOptions): DisplayEntry[] {
  const key = streamEntryKey(scope, serverIndex);
  const existingPosition = entries.findIndex((entry) => entry.key === key);
  const existing =
    existingPosition >= 0 ? entries[existingPosition] : undefined;

  if (operation === "remove") {
    if (existingPosition < 0) return entries;
    const next = [...entries];
    next.splice(existingPosition, 1);
    return next;
  }

  const created = createEntry?.(existing);
  if (!created) return entries;

  const displayEntry: DisplayEntry = { ...created, key };
  const next = [...entries];

  // Replayed `add` and out-of-range `replace` are both upserts. The backend's
  // entry indices are monotonic, so replacing an existing stable key is the
  // only correct behavior when the same path is seen again.
  if (existingPosition >= 0) {
    next[existingPosition] = displayEntry;
    return next;
  }

  // Keep the dense local array in server order even when the retained stream
  // begins in the middle or older paths arrive after newer ones.
  const insertionPosition = next.findIndex((entry) => {
    const entryServerIndex = serverIndexFromEntry(entry, scope);
    return entryServerIndex !== null && entryServerIndex > serverIndex;
  });
  next.splice(
    insertionPosition >= 0 ? insertionPosition : next.length,
    0,
    displayEntry,
  );
  return next;
}
