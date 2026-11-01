import { useSyncExternalStore } from "react";
import { TextFileModel } from "../lib/text-file-model";

/**
 * Open text documents, shared by every view of the same file and kept alive
 * past the view that edited them until their last save lands.
 *
 * Editor tabs unmount when another tab in the pane becomes active, so the
 * save state cannot live in the component: closing a view flushes its pending
 * save here, and reopening the file before that write lands picks up the same
 * document instead of re-reading stale bytes from disk.
 */

type Entry = {
  model: TextFileModel;
  views: number;
  unsubscribe: () => void;
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export type TextFileScope = {
  projectId?: string | null;
  /** Set when the file is read from (and written to) a session worktree. */
  taskRunId?: string | null;
  /** The editor's file path, as carried by the file tab. */
  path: string;
};

export const textFileKey = ({
  projectId,
  taskRunId,
  path,
}: TextFileScope): string =>
  JSON.stringify([projectId ?? null, taskRunId ?? null, path]);

/** Attach a view to the document, creating it on first open. */
export const openTextFile = (
  key: string,
  write: (content: string) => Promise<void>,
  onSaveError?: (error: Error) => void,
): TextFileModel => {
  const existing = entries.get(key);
  if (existing) {
    existing.views += 1;
    return existing.model;
  }
  const model = new TextFileModel({ write, onSaveError });
  entries.set(key, { model, views: 1, unsubscribe: model.subscribe(emit) });
  emit();
  return model;
};

/**
 * Detach a view. The pending save is written right away; the document is
 * dropped once nothing views it and its text is safely on disk. A document
 * whose save failed stays, so reopening the file shows the unsaved text.
 */
export const closeTextFile = (key: string): void => {
  const entry = entries.get(key);
  if (!entry) return;
  entry.views = Math.max(0, entry.views - 1);
  if (entry.views > 0) return;
  void entry.model.settled().then(() => {
    const current = entries.get(key);
    if (current !== entry || entry.views > 0) return;
    if (!entry.model.idle || entry.model.unsaved) return;
    entry.unsubscribe();
    entries.delete(key);
    emit();
  });
};

export const isTextFileUnsaved = (key: string): boolean =>
  entries.get(key)?.model.unsaved ?? false;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether the document has text that is not on disk yet. */
export const useTextFileUnsaved = (key: string | null): boolean =>
  useSyncExternalStore(subscribe, () =>
    key === null ? false : isTextFileUnsaved(key),
  );

export const resetTextFilesForTest = (): void => {
  for (const entry of entries.values()) entry.unsubscribe();
  entries.clear();
  emit();
};
