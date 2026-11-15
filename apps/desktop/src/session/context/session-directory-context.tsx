import type { StoredTask } from "@/session/types";
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
} from "react";

/**
 * Every session the app knows about, addressable by the slug agents write in
 * prose (`20CFfEXi`), plus how to open one.
 *
 * Provided once by the layout, which owns both the cross-project task stream
 * and navigation, and consumed by message renderers that turn a slug into a
 * reference. A store rather than a plain context value: the stream patches on
 * every task change, and only the references whose session actually changed
 * should re-render, not every eight-letter word in the conversation.
 */
export interface SessionDirectory {
  subscribe: (listener: () => void) => () => void;
  bySlug: (slug: string) => StoredTask | undefined;
  open: (task: StoredTask) => void;
}

export interface MutableSessionDirectory extends SessionDirectory {
  update: (
    tasks: readonly StoredTask[],
    open: (task: StoredTask) => void,
  ) => void;
}

export function createSessionDirectory(): MutableSessionDirectory {
  let bySlug = new Map<string, StoredTask>();
  let openTask: (task: StoredTask) => void = () => {};
  const listeners = new Set<() => void>();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bySlug: (slug) => bySlug.get(slug),
    open: (task) => openTask(task),
    update: (tasks, open) => {
      openTask = open;
      const next = new Map<string, StoredTask>();
      for (const task of tasks) {
        if (task.slug) next.set(task.slug, task);
      }
      bySlug = next;
      for (const listener of listeners) listener();
    },
  };
}

const SessionDirectoryContext = createContext<SessionDirectory | null>(null);

export const SessionDirectoryProvider = SessionDirectoryContext.Provider;

const NO_SUBSCRIPTION = () => () => {};

/**
 * The session `slug` names, or `null` when it names none or no directory is
 * provided (a renderer outside the layout keeps the text as written).
 */
export function useSessionBySlug(slug: string | null): StoredTask | null {
  const directory = useContext(SessionDirectoryContext);
  const getSnapshot = useCallback(
    () => (directory && slug ? directory.bySlug(slug) : undefined),
    [directory, slug],
  );
  return (
    useSyncExternalStore(
      directory?.subscribe ?? NO_SUBSCRIPTION,
      getSnapshot,
      getSnapshot,
    ) ?? null
  );
}

/** Open a session the way the session list does; a no-op without a directory. */
export function useOpenSessionFromDirectory(): (task: StoredTask) => void {
  const directory = useContext(SessionDirectoryContext);
  return useCallback((task: StoredTask) => directory?.open(task), [directory]);
}
