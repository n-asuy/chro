import type { DisplayEntry, TaskSessionRecord } from "../types";

export type TaskRunConversationState = {
  taskRunId: string;
  createdAt: string;
  entries: DisplayEntry[];
};

export type TaskRunPromptOverride = {
  prompt: string;
  sessionId?: string | null;
};

export type FlattenConversationEntriesOptions = {
  promptOverridesByRun?: Map<string, TaskRunPromptOverride>;
  loadingRunIds?: Iterable<string>;
};

export type ConversationStreamAction =
  | { type: "start"; runId: string }
  | { type: "keep" }
  | { type: "idle" };

/**
 * Reconcile DB-backed run status with an already-established live log socket.
 *
 * Starting a different active run replaces the old socket. A terminal DB patch
 * alone does not close the current socket: only its protocol-level `finished`
 * marker (or the socket ending) proves that the child stopped producing logs.
 */
export function resolveConversationStreamAction(
  activeRunId: string | null,
  currentStreamRunId: string | null,
): ConversationStreamAction {
  if (activeRunId && activeRunId !== currentStreamRunId) {
    return { type: "start", runId: activeRunId };
  }
  if (currentStreamRunId) {
    return { type: "keep" };
  }
  return { type: "idle" };
}

const isNormalizedUserMessage = (entry: DisplayEntry): boolean =>
  entry.type === "NORMALIZED_ENTRY" &&
  entry.content.entry_type.type === "user_message";

/**
 * Re-stamp each run state's `createdAt` with the authoritative server value when
 * the run is known to the runs stream.
 *
 * Run ordering must derive from a single clock. The per-state `createdAt` is
 * otherwise a mix of optimistic client timestamps (`pendingSubmission.createdAt`)
 * and `now()` fallbacks captured while streaming; comparing those client times
 * against server-stamped times in one sort key let a still-streaming run sort
 * above already-completed runs (the "3rd message jumps to the top" bug). The
 * server `task_runs.created_at` stamps every run on one clock, so it is the
 * authoritative order.
 *
 * A state absent from `authoritativeCreatedAtById` is a brand-new optimistic run
 * the stream has not delivered yet; it keeps its client time and, being the
 * newest, still sorts last.
 */
export function withAuthoritativeRunOrder<
  T extends { taskRunId: string; createdAt: string },
>(states: T[], authoritativeCreatedAtById: ReadonlyMap<string, string>): T[] {
  return states.map((state) => {
    const authoritative = authoritativeCreatedAtById.get(state.taskRunId);
    if (!authoritative || authoritative === state.createdAt) {
      return state;
    }
    // Override only `createdAt`; every other field (entries, finished, …) is
    // preserved. The cast restates that overriding one property of T with a
    // value of its own type still yields a T (a spread of a generic widens it).
    return { ...state, createdAt: authoritative } as T;
  });
}

export function buildTaskSessionPromptMap(
  sessions: TaskSessionRecord[],
): Map<string, TaskSessionRecord> {
  const promptByRun = new Map<string, TaskSessionRecord>();

  for (const session of sessions) {
    if (!session.task_run_id) continue;
    if (!session.prompt?.trim()) continue;
    promptByRun.set(session.task_run_id, session);
  }

  return promptByRun;
}

export function filterConversationLogEntries(
  entries: DisplayEntry[],
  options?: { excludeUserMessages?: boolean },
): DisplayEntry[] {
  if (!options?.excludeUserMessages) {
    return entries;
  }

  return entries.filter((entry) => !isNormalizedUserMessage(entry));
}

export function createSyntheticUserMessageEntry(
  taskRunId: string,
  prompt: string,
  sessionId?: string,
  createdAt?: string,
): DisplayEntry {
  const id = sessionId
    ? `synthetic-user-${sessionId}`
    : `synthetic-user-${taskRunId}`;

  return {
    type: "NORMALIZED_ENTRY",
    key: `${taskRunId}:${id}`,
    content: {
      id,
      // The backend never stamps user_message entries, so the run's
      // creation time is the most accurate moment the user sent this prompt.
      timestamp: createdAt ?? null,
      entry_type: { type: "user_message" },
      content: prompt,
    },
  };
}

export function createLoadingEntry(taskRunId: string): DisplayEntry {
  const id = `loading-${taskRunId}`;

  return {
    type: "NORMALIZED_ENTRY",
    key: `${taskRunId}:${id}`,
    content: {
      id,
      timestamp: null,
      entry_type: { type: "loading" },
      content: "",
    },
  };
}

function resolvePromptByRun(
  sessions: TaskSessionRecord[],
  options?: FlattenConversationEntriesOptions,
): Map<string, TaskRunPromptOverride> {
  const promptByRun = new Map<string, TaskRunPromptOverride>();

  for (const [taskRunId, override] of options?.promptOverridesByRun ?? []) {
    if (!override.prompt.trim()) continue;
    promptByRun.set(taskRunId, override);
  }

  for (const [taskRunId, session] of buildTaskSessionPromptMap(sessions)) {
    promptByRun.set(taskRunId, {
      prompt: session.prompt ?? "",
      sessionId: session.id,
    });
  }

  return promptByRun;
}

function buildRunSlice(
  state: TaskRunConversationState,
  promptOverride: TaskRunPromptOverride | undefined,
  isLoading: boolean,
  previousSynthetic: DisplayEntry | null,
  previousLoading: DisplayEntry | null,
): {
  synthetic: DisplayEntry | null;
  loadingEntry: DisplayEntry | null;
  filteredLog: DisplayEntry[];
  entries: DisplayEntry[];
} {
  const sessionPrompt = promptOverride?.prompt;
  const excludeUserMessages = Boolean(sessionPrompt);

  const synthetic = sessionPrompt
    ? previousSynthetic ??
      createSyntheticUserMessageEntry(
        state.taskRunId,
        sessionPrompt,
        promptOverride?.sessionId ?? undefined,
        state.createdAt,
      )
    : null;

  const filteredLog = filterConversationLogEntries(state.entries, {
    excludeUserMessages,
  });

  const loadingEntry = isLoading
    ? previousLoading ?? createLoadingEntry(state.taskRunId)
    : null;

  const entries: DisplayEntry[] = [];
  if (synthetic) entries.push(synthetic);
  for (const entry of filteredLog) entries.push(entry);
  if (loadingEntry) entries.push(loadingEntry);

  return { synthetic, loadingEntry, filteredLog, entries };
}

export function flattenConversationEntries(
  states: TaskRunConversationState[],
  sessions: TaskSessionRecord[],
  options?: FlattenConversationEntriesOptions,
): DisplayEntry[] {
  const promptByRun = resolvePromptByRun(sessions, options);
  const loadingRunIds = new Set(options?.loadingRunIds ?? []);

  return [...states]
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    .flatMap((state) => {
      const { entries } = buildRunSlice(
        state,
        promptByRun.get(state.taskRunId),
        loadingRunIds.has(state.taskRunId),
        null,
        null,
      );
      return entries;
    });
}

/**
 * Incremental flatten with per-run memoization.
 *
 * Streaming a single TaskRun produces many JSON-patch updates per second.
 * Without caching, every patch re-runs the entire flatten over every run in
 * the task — O(total history) per patch. With this cache:
 *
 *   - Each run's slice (synthetic user message + filtered log + loading) is
 *     remembered by `taskRunId` and invalidated only when its source
 *     `entries` reference, prompt, or loading flag changes.
 *   - The concatenated array's element references are stable for runs whose
 *     slice didn't change, so downstream `React.memo` / prefix-equality
 *     checks (aggregator, group memoization) actually hit.
 *   - During streaming only the active run rebuilds its slice; the rest of
 *     the conversation incurs no work and produces no new object identities.
 */
export type ConversationFlattenCache = {
  flatten: (
    states: TaskRunConversationState[],
    sessions: TaskSessionRecord[],
    options?: FlattenConversationEntriesOptions,
  ) => DisplayEntry[];
  clear: () => void;
};

type RunSliceCacheEntry = {
  sourceEntries: DisplayEntry[];
  sourceCreatedAt: string;
  promptKey: string;
  isLoading: boolean;
  synthetic: DisplayEntry | null;
  loadingEntry: DisplayEntry | null;
  entries: DisplayEntry[];
};

function promptCacheKey(
  promptOverride: TaskRunPromptOverride | undefined,
): string {
  if (!promptOverride?.prompt) return "";
  return `${promptOverride.prompt} ${promptOverride.sessionId ?? ""}`;
}

export function createConversationFlattenCache(): ConversationFlattenCache {
  const sliceCache = new Map<string, RunSliceCacheEntry>();
  let lastFlatten: DisplayEntry[] | null = null;
  let lastSliceRefs: DisplayEntry[][] | null = null;

  return {
    flatten(states, sessions, options) {
      const promptByRun = resolvePromptByRun(sessions, options);
      const loadingRunIds = new Set(options?.loadingRunIds ?? []);

      const sortedStates = [...states].sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );

      const seenRunIds = new Set<string>();
      const sliceRefs: DisplayEntry[][] = new Array(sortedStates.length);
      let allSlicesUnchanged =
        lastSliceRefs !== null && lastSliceRefs.length === sortedStates.length;

      for (let i = 0; i < sortedStates.length; i++) {
        const state = sortedStates[i];
        seenRunIds.add(state.taskRunId);

        const promptOverride = promptByRun.get(state.taskRunId);
        const promptKey = promptCacheKey(promptOverride);
        const isLoading = loadingRunIds.has(state.taskRunId);

        const existing = sliceCache.get(state.taskRunId);
        let slice: RunSliceCacheEntry;
        if (
          existing &&
          existing.sourceEntries === state.entries &&
          existing.sourceCreatedAt === state.createdAt &&
          existing.promptKey === promptKey &&
          existing.isLoading === isLoading
        ) {
          slice = existing;
        } else {
          const previousSynthetic =
            existing &&
            existing.promptKey === promptKey &&
            existing.sourceCreatedAt === state.createdAt
              ? existing.synthetic
              : null;
          const previousLoading = existing?.loadingEntry ?? null;
          const built = buildRunSlice(
            state,
            promptOverride,
            isLoading,
            previousSynthetic,
            previousLoading,
          );
          slice = {
            sourceEntries: state.entries,
            sourceCreatedAt: state.createdAt,
            promptKey,
            isLoading,
            synthetic: built.synthetic,
            loadingEntry: built.loadingEntry,
            entries: built.entries,
          };
          sliceCache.set(state.taskRunId, slice);
        }

        if (
          allSlicesUnchanged &&
          lastSliceRefs &&
          lastSliceRefs[i] !== slice.entries
        ) {
          allSlicesUnchanged = false;
        }
        sliceRefs[i] = slice.entries;
      }

      for (const runId of [...sliceCache.keys()]) {
        if (!seenRunIds.has(runId)) sliceCache.delete(runId);
      }

      if (allSlicesUnchanged && lastFlatten !== null) {
        return lastFlatten;
      }

      const flat: DisplayEntry[] = [];
      for (const slice of sliceRefs) {
        for (const entry of slice) flat.push(entry);
      }
      lastFlatten = flat;
      lastSliceRefs = sliceRefs;
      return flat;
    },
    clear() {
      sliceCache.clear();
      lastFlatten = null;
      lastSliceRefs = null;
    },
  };
}
