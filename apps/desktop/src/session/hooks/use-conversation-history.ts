import { useOptionalLanguage } from "@/i18n";
import { getBackendBaseUrl } from "@/lib/backend-client";
import { recordPerfEvent } from "@/perf/recorder";
/**
 * Hook for aggregating conversation history across all TaskRuns for a Task.
 *
 * User prompts come from task session metadata so follow-up turns remain
 * visible even if live log normalization drops a user_message patch.
 *
 * Also extracts approval records from `/approvals/*` patches in the active
 * run's log stream, eliminating the need for a separate WebSocket connection.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ConversationFlattenCache,
  type HistoricReplayResult,
  createConversationFlattenCache,
  resolveConversationStreamAction,
  shouldReplaceLiveEntriesWithReplay,
  withAuthoritativeRunOrder,
} from "../domain/conversation-history";
import {
  type PendingSessionSubmission,
  isPendingSubmissionForTaskScope,
} from "../domain/session-task-state";
import type {
  DisplayEntry,
  NormalizedEntry,
  TaskRunRecord,
  TaskSessionRecord,
} from "../types";
import type { ApprovalRecord } from "../types/api";
import { applyIndexedDisplayEntryOperation } from "../utils/indexed-display-entry";
import { dedupeJsonPatchOperations } from "../utils/json-patch-stream";
import { useTaskRunsStream } from "./use-task-runs-stream";
import { useTaskSessionsStream } from "./use-task-sessions-stream";

export interface UseConversationHistoryResult {
  entries: DisplayEntry[];
  isLoading: boolean;
  isLoadingMoreHistory: boolean;
  hasMoreHistory: boolean;
  isStreaming: boolean;
  error: string | null;
  /** ID of the currently running TaskRun (if any) */
  activeRunId: string | null;
  /** ID whose live log socket is open and has not emitted `finished`. */
  streamingRunId: string | null;
  /** ID of the most recent TaskRun (running or completed) */
  latestRunId: string | null;
  /** Approval records from the active run's log stream. */
  approvals: Record<string, ApprovalRecord>;
  /** Clear all approval records (e.g. after merge). */
  resetApprovals: () => void;
  /** Load the next page of older completed TaskRuns. */
  loadMoreHistory: () => Promise<void>;
}

interface UseConversationHistoryParams {
  sessionScopeId?: string | null;
  taskId: string | null;
  enabled?: boolean;
  runs?: TaskRunRecord[];
  runsLoading?: boolean;
  runsError?: string | null;
  sessions?: TaskSessionRecord[];
  sessionsLoading?: boolean;
  sessionsError?: string | null;
  pendingSubmission?: PendingSessionSubmission | null;
  callbacks?: {
    onFinished?: () => void;
  };
}

// Entry types from the WebSocket stream
type ServerWireEntry = {
  timestamp?: string | null;
  type: { type: string; [key: string]: unknown };
  content: string;
  metadata?: Record<string, unknown>;
};

type PatchValue =
  | { type: "NORMALIZED_ENTRY"; content: ServerWireEntry }
  | { type: "STDOUT"; content: string }
  | { type: "STDERR"; content: string };

type JsonPatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: PatchValue;
};

type LogEntryMessage = {
  JsonPatch?: JsonPatchOperation[];
  finished?: boolean;
};

// State for entries from a single TaskRun
type TaskRunEntriesState = {
  taskRunId: string;
  createdAt: string;
  entries: DisplayEntry[];
  finished: boolean;
};

let entryIdCounter = 0;
const generateEntryId = (): string => {
  entryIdCounter += 1;
  return `entry-${Date.now()}-${entryIdCounter}`;
};

const INITIAL_HISTORY_RUN_COUNT = 3;
const HISTORY_RUN_PAGE_SIZE = 3;
/**
 * Idle timeout for a single historic-run log replay: give up only after the
 * stream goes silent this long without finishing/closing. It re-arms on every
 * message, and the server sends a liveness marker immediately on connect, so
 * this measures true silence — not replay duration. Giving up marks the replay
 * incomplete (retryable); it never fabricates an authoritative empty history.
 */
const HISTORIC_LOAD_IDLE_TIMEOUT_MS = 30_000;
/**
 * Backoff between automatic retries of an incomplete historic replay. Length
 * bounds the retry count; after that the runs stay unloaded so the
 * load-earlier-history affordance can retry manually.
 */
const HISTORY_RETRY_BACKOFF_MS = [1_000, 3_000];

function sortRunsByCreatedAtAscending(
  taskRuns: TaskRunRecord[],
): TaskRunRecord[] {
  return [...taskRuns].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

function getUnloadedHistoricRunsNewestFirst(
  taskRuns: TaskRunRecord[],
  activeRunId: string | null,
  loadedRunIds: ReadonlySet<string>,
): TaskRunRecord[] {
  return sortRunsByCreatedAtAscending(taskRuns)
    .filter(
      (run) =>
        run.status !== "running" &&
        run.id !== activeRunId &&
        !loadedRunIds.has(run.id),
    )
    .reverse();
}

function createNormalizedDisplayEntry(
  entry: ServerWireEntry,
  taskRunId: string,
  existing?: DisplayEntry,
): DisplayEntry {
  const { type: entryType, ...rest } = entry;
  const id =
    existing?.type === "NORMALIZED_ENTRY"
      ? existing.content.id
      : generateEntryId();
  return {
    type: "NORMALIZED_ENTRY",
    content: {
      id,
      entry_type: entryType as NormalizedEntry["entry_type"],
      ...rest,
    },
    key: existing?.key ?? `${taskRunId}:${id}`,
  };
}

function createStdoutDisplayEntry(
  content: string,
  taskRunId: string,
  existing?: DisplayEntry,
): DisplayEntry {
  const key = existing?.key ?? `${taskRunId}:${generateEntryId()}`;
  return {
    type: "STDOUT",
    content,
    key,
  };
}

function createStderrDisplayEntry(
  content: string,
  taskRunId: string,
  existing?: DisplayEntry,
): DisplayEntry {
  const key = existing?.key ?? `${taskRunId}:${generateEntryId()}`;
  return {
    type: "STDERR",
    content,
    key,
  };
}

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

function applyEntriesPatch(
  entries: DisplayEntry[],
  op: JsonPatchOperation,
  taskRunId: string,
): DisplayEntry[] {
  const entriesMatch = op.path.match(/^\/entries\/(\d+)$/);
  if (!entriesMatch) {
    return entries;
  }

  const index = Number.parseInt(entriesMatch[1], 10);
  if (Number.isNaN(index)) {
    return entries;
  }

  return applyIndexedDisplayEntryOperation({
    entries,
    scope: taskRunId,
    serverIndex: index,
    operation: op.op,
    createEntry: (existingEntry) => {
      if (!op.value) return null;
      if (op.value.type === "NORMALIZED_ENTRY") {
        return createNormalizedDisplayEntry(
          op.value.content,
          taskRunId,
          existingEntry,
        );
      }
      if (op.value.type === "STDOUT") {
        return createStdoutDisplayEntry(
          op.value.content,
          taskRunId,
          existingEntry,
        );
      }
      if (op.value.type === "STDERR") {
        return createStderrDisplayEntry(
          op.value.content,
          taskRunId,
          existingEntry,
        );
      }
      return null;
    },
  });
}

export function applyConversationEntriesPatches(
  entries: DisplayEntry[],
  ops: JsonPatchOperation[],
  taskRunId: string,
): DisplayEntry[] {
  return dedupeJsonPatchOperations(ops).reduce(
    (current, op) => applyEntriesPatch(current, op, taskRunId),
    entries,
  );
}

/**
 * Load entries from a historic (non-running) TaskRun via WebSocket.
 *
 * Never rejects. The returned result's `complete` flag says whether the
 * replay is authoritative: true only when the server ended it (protocol
 * `finished` marker or a clean close). An idle timeout, socket error, or
 * unclean close yields `complete: false` — the caller must treat that as a
 * retryable failure, not as the run's true (empty) history.
 */
/// Exported for the fork-origin block: a fork renders its source's history the
/// same way this hook replays its own historic runs, and the replay stream is
/// run-scoped so a foreign task's runs load identically.
export function loadHistoricTaskRunEntries(
  taskRunId: string,
): Promise<HistoricReplayResult> {
  return new Promise((resolve) => {
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    const endpoint = httpToWs(
      `${baseUrl}/streams/task-runs/${encodeURIComponent(taskRunId)}/logs`,
    );
    const ws = new WebSocket(endpoint);
    let entries: DisplayEntry[] = [];
    let settled = false;
    let finishedMarkerSeen = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (complete: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve({ entries, complete });
    };

    // Safety net: a historic replay must terminate. This is an *idle* timeout,
    // not an absolute one — it is re-armed on every message (the server sends a
    // liveness marker right after connect, then the replayed patches), so a
    // large run that legitimately streams for a while is never truncated. A
    // stream that goes truly silent is abandoned as incomplete so `isLoading`
    // always resolves and the caller can retry.
    const armIdleTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        settle(false);
        try {
          ws.close();
        } catch {
          // ignore
        }
      }, HISTORIC_LOAD_IDLE_TIMEOUT_MS);
    };
    armIdleTimer();

    ws.onmessage = (event) => {
      armIdleTimer(); // data is flowing; push the idle deadline back
      try {
        const msg = JSON.parse(event.data) as LogEntryMessage;

        if (msg.JsonPatch) {
          entries = applyConversationEntriesPatches(
            entries,
            msg.JsonPatch,
            taskRunId,
          );
        }

        if (msg.finished) {
          finishedMarkerSeen = true;
          settle(true);
          ws.close(1000, "finished");
        }
      } catch (err) {
        console.error(
          `[loadHistoricTaskRunEntries] Error processing message for ${taskRunId}:`,
          err,
        );
      }
    };

    ws.onerror = () => {
      settle(false);
    };

    ws.onclose = (event) => {
      // Some persisted runs genuinely have no replayable log entries; the
      // server ends those replays with a clean close. Only a clean close is
      // authoritative — an unclean one (server died, network dropped) must
      // surface as incomplete so the caller retries instead of recording an
      // empty history.
      settle(finishedMarkerSeen || event.wasClean);
    };
  });
}

/**
 * Stream entries from a running TaskRun via WebSocket.
 * Returns a controller to close the stream.
 */
function streamRunningTaskRunEntries(
  taskRunId: string,
  onPatch: (patch: JsonPatchOperation[]) => void,
  onFinished: () => void,
  onClosedWithoutFinished: () => void,
): { close: () => void } {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const endpoint = httpToWs(
    `${baseUrl}/streams/task-runs/${encodeURIComponent(taskRunId)}/logs`,
  );
  const ws = new WebSocket(endpoint);
  let closed = false;
  let finished = false;
  let connectedAt: number | null = null;
  let firstPatchSeen = false;
  let patchMessages = 0;
  let patchOps = 0;
  let pendingOps: JsonPatchOperation[] = [];
  let flushTimerId: number | null = null;

  const flushPendingOps = () => {
    flushTimerId = null;
    if (closed || pendingOps.length === 0) {
      pendingOps = [];
      return;
    }

    const ops = pendingOps;
    pendingOps = [];
    onPatch(dedupeJsonPatchOperations(ops));
  };

  ws.onopen = () => {
    connectedAt = performance.now();
    recordPerfEvent("conv_stream_opened", {
      task_run_id: taskRunId,
    });
  };

  ws.onmessage = (event) => {
    if (closed) return;

    try {
      const msg = JSON.parse(event.data) as LogEntryMessage;

      if (msg.JsonPatch) {
        patchMessages += 1;
        patchOps += msg.JsonPatch.length;

        if (!firstPatchSeen) {
          firstPatchSeen = true;
          recordPerfEvent("conv_stream_first_patch", {
            task_run_id: taskRunId,
            time_to_first_patch_ms:
              connectedAt === null
                ? null
                : Math.round((performance.now() - connectedAt) * 100) / 100,
            patch_ops: msg.JsonPatch.length,
          });
        }

        pendingOps.push(...msg.JsonPatch);
        if (flushTimerId === null) {
          flushTimerId = window.setTimeout(flushPendingOps, 0);
        }
      }

      if (msg.finished) {
        finished = true;
        if (flushTimerId !== null) {
          window.clearTimeout(flushTimerId);
        }
        flushPendingOps();
        recordPerfEvent("conv_stream_finished", {
          task_run_id: taskRunId,
          elapsed_ms:
            connectedAt === null
              ? null
              : Math.round((performance.now() - connectedAt) * 100) / 100,
          patch_messages: patchMessages,
          patch_ops: patchOps,
        });
        onFinished();
        ws.close(1000, "finished");
      }
    } catch (err) {
      console.error(
        `[streamRunningTaskRunEntries] Error processing message for ${taskRunId}:`,
        err,
      );
    }
  };

  ws.onerror = () => {
    recordPerfEvent("conv_stream_error", {
      task_run_id: taskRunId,
    });
    console.error(
      `[streamRunningTaskRunEntries] WebSocket error for ${taskRunId}`,
    );
  };

  ws.onclose = (evt) => {
    if (closed || finished) return;

    recordPerfEvent("conv_stream_closed_unexpectedly", {
      task_run_id: taskRunId,
      close_code: evt?.code ?? null,
      was_clean: Boolean(evt?.wasClean),
      patch_messages: patchMessages,
    });
    onClosedWithoutFinished();
  };

  return {
    close: () => {
      closed = true;
      if (flushTimerId !== null) {
        window.clearTimeout(flushTimerId);
        flushTimerId = null;
      }
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    },
  };
}

/**
 * Usage:
 * ```tsx
 * const { entries, isLoading, isStreaming } = useConversationHistory({
 *   taskId: activeTaskId,
 *   enabled: Boolean(activeTaskId),
 * });
 * ```
 */
export function useConversationHistory({
  sessionScopeId = null,
  taskId,
  enabled = true,
  runs: providedRuns,
  runsLoading: providedRunsLoading,
  runsError: providedRunsError,
  sessions: providedSessions,
  sessionsLoading: providedSessionsLoading,
  sessionsError: providedSessionsError,
  pendingSubmission,
  callbacks,
}: UseConversationHistoryParams): UseConversationHistoryResult {
  // State for entries from each TaskRun
  const taskRunEntriesRef = useRef<Map<string, TaskRunEntriesState>>(new Map());
  const flattenCacheRef = useRef<ConversationFlattenCache>(
    createConversationFlattenCache(),
  );
  const [entriesVersion, setEntriesVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMoreHistory, setIsLoadingMoreHistory] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Approval records extracted from /approvals/* patches in the active stream
  const approvalsRef = useRef<Record<string, ApprovalRecord>>({});
  const [approvals, setApprovals] = useState<Record<string, ApprovalRecord>>(
    {},
  );

  // Optional so the hook stays usable outside a LanguageProvider (tests).
  const language = useOptionalLanguage();
  const translateRef = useRef(language?.t ?? null);
  translateRef.current = language?.t ?? null;

  const hasProvidedRuns = providedRuns !== undefined;
  const hasProvidedSessions = providedSessions !== undefined;
  const pendingSubmissionCandidate = pendingSubmission ?? null;
  const scopedPendingSubmission = isPendingSubmissionForTaskScope(
    pendingSubmissionCandidate,
    taskId,
    taskId,
    sessionScopeId,
  )
    ? pendingSubmissionCandidate
    : null;
  const taskScopeId = taskId ?? scopedPendingSubmission?.tempTaskId ?? null;

  // Stream of TaskRuns for this Task
  const streamedRuns = useTaskRunsStream({
    taskId,
    enabled: !hasProvidedRuns && enabled && !!taskId,
  });

  const streamedSessions = useTaskSessionsStream({
    taskId,
    enabled: !hasProvidedSessions && enabled && !!taskId,
  });

  const runs = providedRuns ?? streamedRuns.runs;
  const runsLoading = hasProvidedRuns
    ? providedRunsLoading ?? false
    : streamedRuns.isLoading;
  const runsError = hasProvidedRuns
    ? providedRunsError ?? null
    : streamedRuns.error;

  const sessions = providedSessions ?? streamedSessions.sessions;
  const sessionsLoading = hasProvidedSessions
    ? providedSessionsLoading ?? false
    : streamedSessions.isLoading;
  const sessionsError = hasProvidedSessions
    ? providedSessionsError ?? null
    : streamedSessions.error;

  // Track which TaskRuns we've loaded and which is actively streaming
  const loadedRunIdsRef = useRef<Set<string>>(new Set());
  const initialHistoryLoadedRef = useRef(false);
  const historyLoadingRef = useRef(false);
  const activeStreamRef = useRef<{ runId: string; close: () => void } | null>(
    null,
  );
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Find the running TaskRun — prefer the API response (pendingSubmission.runId)
  // which is available immediately, over WS-derived status which races.
  const wsActiveRun = useMemo(
    () => runs.find((r) => r.status === "running"),
    [runs],
  );
  const pendingActiveRunId = scopedPendingSubmission?.finishedAt
    ? null
    : scopedPendingSubmission?.runId;
  const activeRunId = pendingActiveRunId ?? wsActiveRun?.id ?? null;
  const effectiveLiveRunId = streamingRunId ?? activeRunId;

  const latestRunId = useMemo(() => {
    if (runs.length === 0) return null;
    const sorted = sortRunsByCreatedAtAscending(runs);
    return sorted[sorted.length - 1].id;
  }, [runs]);

  // Authoritative run ordering: the server stamps every run's created_at on one
  // clock. A run state's own createdAt is assembled from optimistic client times
  // and now() fallbacks, so it cannot be trusted to order runs relative to one
  // another (it let a streaming run sort above completed ones). Keyed by run id.
  const runCreatedAtById = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs) map.set(run.id, run.created_at);
    return map;
  }, [runs]);

  // Diagnostic: surface why the conversation pane can sit in `isLoading`. Fires
  // on any change to the gating inputs so a stuck-loading reproduction reveals
  // which gate failed to resolve — the runs stream (`runs_loading`) or the
  // historic replay loop (`history_loading` true with `is_loading` still true).
  useEffect(() => {
    recordPerfEvent("conv_history_loading_state", {
      task_id: taskId,
      is_loading: isLoading,
      runs_loading: runsLoading,
      runs_count: runs.length,
      loaded_runs: loadedRunIdsRef.current.size,
      history_loading: historyLoadingRef.current,
      active_run_id: activeRunId,
      initial_history_loaded: initialHistoryLoadedRef.current,
    });
  }, [isLoading, runsLoading, runs.length, activeRunId, taskId]);

  // Helper to update entries state (batched via setTimeout to avoid per-patch
  // re-renders while still firing when the window is in the background)
  const pendingVersionUpdateRef = useRef(false);
  const updateEntriesVersion = useCallback(() => {
    if (pendingVersionUpdateRef.current) return;
    pendingVersionUpdateRef.current = true;
    window.setTimeout(() => {
      pendingVersionUpdateRef.current = false;
      setEntriesVersion((v: number) => v + 1);
    }, 0);
  }, []);

  const applyApprovalPatches = useCallback((ops: JsonPatchOperation[]) => {
    let changed = false;
    const next = { ...approvalsRef.current };
    for (const op of ops) {
      const segments = op.path.split("/").filter(Boolean);
      if (segments[0] !== "approvals" || segments.length < 2) continue;
      const approvalId = segments[1];
      if (op.op === "remove") {
        if (approvalId in next) {
          delete next[approvalId];
          changed = true;
        }
      } else if (op.value !== undefined) {
        next[approvalId] = op.value as unknown as ApprovalRecord;
        changed = true;
      }
    }
    if (changed) {
      approvalsRef.current = next;
      setApprovals(next);
    }
  }, []);

  const resetApprovals = useCallback(() => {
    approvalsRef.current = {};
    setApprovals({});
  }, []);

  // Reset state when taskId changes
  useEffect(() => {
    taskRunEntriesRef.current.clear();
    loadedRunIdsRef.current.clear();
    initialHistoryLoadedRef.current = false;
    historyLoadingRef.current = false;
    flattenCacheRef.current.clear();
    if (activeStreamRef.current) {
      activeStreamRef.current.close();
      activeStreamRef.current = null;
    }
    setIsLoading(Boolean(taskId));
    setIsLoadingMoreHistory(false);
    setIsStreaming(false);
    setStreamingRunId(null);
    setError(null);
    setEntriesVersion(0);
    resetApprovals();
  }, [taskId, taskScopeId, sessionScopeId, resetApprovals]);

  const loadHistoricRuns = useCallback(
    async (
      count: number,
      options: { cancelled?: () => boolean; markInitialLoaded?: boolean } = {},
    ) => {
      if (!enabled || !taskId || runsLoading) return;
      if (historyLoadingRef.current) return;

      const historicRuns = getUnloadedHistoricRunsNewestFirst(
        runs,
        effectiveLiveRunId,
        loadedRunIdsRef.current,
      ).slice(0, count);

      if (historicRuns.length === 0) {
        if (options.markInitialLoaded) setIsLoading(false);
        return;
      }

      historyLoadingRef.current = true;
      setIsLoadingMoreHistory(true);

      try {
        // Replay the runs in parallel, not one-after-another: a single wedged
        // replay (one that hits HISTORIC_LOAD_IDLE_TIMEOUT_MS instead of finishing)
        // must not serialize behind the others. Worst-case wait for the page is
        // one timeout, not N. An incomplete replay is retried with backoff;
        // it is never committed as the run's history, so a transiently
        // overloaded server can no longer turn a conversation blank.
        let targets = historicRuns;
        for (let attempt = 0; targets.length > 0; attempt += 1) {
          const incomplete: TaskRunRecord[] = [];
          await Promise.allSettled(
            targets.map(async (run) => {
              if (options.cancelled?.()) return;
              const result = await loadHistoricTaskRunEntries(run.id);
              if (options.cancelled?.()) return;
              if (!result.complete) {
                incomplete.push(run);
                recordPerfEvent("conv_history_replay_incomplete", {
                  task_run_id: run.id,
                  attempt,
                  partial_entries: result.entries.length,
                });
                return;
              }
              taskRunEntriesRef.current.set(run.id, {
                taskRunId: run.id,
                createdAt: run.created_at,
                entries: result.entries,
                finished: true,
              });
              loadedRunIdsRef.current.add(run.id);
              updateEntriesVersion();
            }),
          );

          if (options.cancelled?.()) return;
          if (incomplete.length === 0) {
            setError(null);
            return;
          }
          if (attempt >= HISTORY_RETRY_BACKOFF_MS.length) {
            recordPerfEvent("conv_history_replay_gave_up", {
              task_id: taskId,
              failed_runs: incomplete.length,
            });
            setError(
              translateRef.current?.("conversationHistoryLoadFailed") ??
                "Couldn't load conversation history.",
            );
            return;
          }
          await new Promise((resolveDelay) =>
            setTimeout(resolveDelay, HISTORY_RETRY_BACKOFF_MS[attempt]),
          );
          if (options.cancelled?.()) return;
          targets = incomplete;
        }
      } finally {
        historyLoadingRef.current = false;
        if (!options.cancelled?.()) {
          setIsLoadingMoreHistory(false);
          if (options.markInitialLoaded) setIsLoading(false);
        }
      }
    },
    [
      effectiveLiveRunId,
      enabled,
      runs,
      runsLoading,
      taskId,
      updateEntriesVersion,
    ],
  );

  const loadMoreHistory = useCallback(
    () => loadHistoricRuns(HISTORY_RUN_PAGE_SIZE),
    [loadHistoricRuns],
  );

  // Always-latest handle to the historic loader. Effect 1 calls through this ref
  // so it does NOT have to depend on `loadHistoricRuns`, whose identity changes
  // on every runs-stream patch.
  const loadHistoricRunsRef = useRef(loadHistoricRuns);
  loadHistoricRunsRef.current = loadHistoricRuns;

  // Effect 1: Load the newest completed TaskRuns once the runs stream is ready.
  //
  // Keyed only on stable inputs (`enabled`, `taskId`, `runsLoading`) — NOT on
  // `loadHistoricRuns`. Depending on the callback made this effect re-run on
  // every runs-stream patch (each patch yields a new `runs` reference → new
  // callback identity). Its cleanup then cancelled the in-flight historic load
  // and reset `initialHistoryLoadedRef`, so for any task with churning runs the
  // load never completed and `markInitialLoaded` never fired `setIsLoading(false)`
  // — leaving the conversation pane stuck on its loading spinner. The
  // taskId-reset effect already clears `initialHistoryLoadedRef`, so the cleanup
  // here must not.
  useEffect(() => {
    if (!enabled || !taskId) {
      setIsLoading(false);
      return;
    }
    if (runsLoading) return; // re-runs when runsLoading settles false
    if (initialHistoryLoadedRef.current) return;
    initialHistoryLoadedRef.current = true;

    let cancelled = false;
    void loadHistoricRunsRef.current(INITIAL_HISTORY_RUN_COUNT, {
      cancelled: () => cancelled,
      markInitialLoaded: true,
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, runsLoading, taskId]);

  // Effect 2: Stream the running TaskRun — fire-and-forget.
  // No cancelled flag. The stream is autonomous and survives effect re-runs.
  // Dedup via activeStreamRef prevents duplicate streams.
  // Depends on activeRunId (primitive), not runs (object reference).
  const activeRunCreatedAt =
    scopedPendingSubmission?.createdAt ?? wsActiveRun?.created_at ?? null;

  useEffect(() => {
    if (!enabled || !taskId) return;

    const streamAction = resolveConversationStreamAction(
      activeRunId,
      activeStreamRef.current?.runId ?? null,
    );

    if (streamAction.type === "start") {
      if (activeStreamRef.current) {
        activeStreamRef.current.close();
      }

      const createdAt = activeRunCreatedAt ?? new Date().toISOString();
      const runId = streamAction.runId;

      if (!taskRunEntriesRef.current.has(runId)) {
        taskRunEntriesRef.current.set(runId, {
          taskRunId: runId,
          createdAt: createdAt,
          entries: [],
          finished: false,
        });
      }

      setIsStreaming(true);
      setStreamingRunId(runId);
      resetApprovals();

      const controller = streamRunningTaskRunEntries(
        runId,
        (patchOps) => {
          const state = taskRunEntriesRef.current.get(runId);
          if (state) {
            state.entries = applyConversationEntriesPatches(
              state.entries,
              patchOps,
              runId,
            );
            updateEntriesVersion();
          }
          applyApprovalPatches(patchOps);
        },
        () => {
          loadedRunIdsRef.current.add(runId);
          setIsStreaming(false);
          setStreamingRunId(null);
          activeStreamRef.current = null;

          void loadHistoricTaskRunEntries(runId)
            .then((result) => {
              const liveState = taskRunEntriesRef.current.get(runId);
              const liveEntryCount = liveState?.entries.length ?? 0;
              if (shouldReplaceLiveEntriesWithReplay(result, liveEntryCount)) {
                taskRunEntriesRef.current.set(runId, {
                  taskRunId: runId,
                  createdAt: createdAt,
                  entries: result.entries,
                  finished: true,
                });
                return;
              }
              // The replay was incomplete (or authoritative-empty against a
              // non-empty live turn). Keep what the user already watched
              // stream in rather than clobbering it.
              if (liveState) liveState.finished = true;
              recordPerfEvent("conv_finished_replay_kept_live", {
                task_run_id: runId,
                replay_complete: result.complete,
                replay_entries: result.entries.length,
                live_entries: liveEntryCount,
              });
            })
            .finally(() => {
              callbacksRef.current?.onFinished?.();
              updateEntriesVersion();
            });
        },
        () => {
          // A socket that ends without the protocol's `finished` marker is not
          // proof of completion. Stop presenting it as live, but do not run the
          // finalized-history path or invoke completion callbacks.
          if (activeStreamRef.current?.runId === runId) {
            activeStreamRef.current = null;
            setIsStreaming(false);
            setStreamingRunId(null);
          }
        },
      );

      activeStreamRef.current = { runId, close: controller.close };
    }
    // Do not close an established stream merely because the DB-backed runs
    // stream went terminal. A cleanup race can publish `failed` while the child
    // and its log socket are still alive. The log protocol's `finished` marker
    // (or the socket actually ending) is the authoritative lifecycle boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, taskId, activeRunId, sessionScopeId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (activeStreamRef.current) {
        activeStreamRef.current.close();
        activeStreamRef.current = null;
      }
    };
  }, []);

  // Aggregate and sort entries from all TaskRuns
  const entries = useMemo(() => {
    const allStates: TaskRunEntriesState[] = Array.from(
      taskRunEntriesRef.current.values(),
    );
    const pendingRunId =
      scopedPendingSubmission?.runId ?? scopedPendingSubmission?.tempRunId;

    if (
      scopedPendingSubmission &&
      pendingRunId &&
      !allStates.some((state) => state.taskRunId === pendingRunId)
    ) {
      allStates.push({
        taskRunId: pendingRunId,
        createdAt: scopedPendingSubmission.createdAt,
        entries: [],
        finished: Boolean(scopedPendingSubmission.finishedAt),
      });
    }

    const promptOverridesByRun = new Map<
      string,
      { prompt: string; sessionId?: string | null }
    >();
    if (scopedPendingSubmission && pendingRunId) {
      promptOverridesByRun.set(pendingRunId, {
        prompt: scopedPendingSubmission.prompt,
      });
    }

    const loadingRunIds = new Set<string>();
    if (isStreaming && streamingRunId) {
      loadingRunIds.add(streamingRunId);
    }
    if (pendingRunId && !scopedPendingSubmission?.finishedAt) {
      loadingRunIds.add(pendingRunId);
    }

    // Order runs by the server's authoritative created_at, not each state's
    // self-assembled client/optimistic time, so a streaming run can never sort
    // above already-completed runs.
    const orderedStates = withAuthoritativeRunOrder(
      allStates,
      runCreatedAtById,
    );

    return flattenCacheRef.current.flatten(orderedStates, sessions, {
      promptOverridesByRun,
      loadingRunIds,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRunId,
    streamingRunId,
    entriesVersion,
    isStreaming,
    runCreatedAtById,
    scopedPendingSubmission,
    sessionScopeId,
    sessions,
  ]);

  const hasMoreHistory = useMemo(() => {
    if (!enabled || !taskId || runsLoading) return false;
    return (
      getUnloadedHistoricRunsNewestFirst(
        runs,
        effectiveLiveRunId,
        loadedRunIdsRef.current,
      ).length > 0
    );
  }, [effectiveLiveRunId, enabled, entriesVersion, runs, runsLoading, taskId]);

  return {
    entries,
    isLoading: isLoading || runsLoading || sessionsLoading,
    isLoadingMoreHistory,
    hasMoreHistory,
    isStreaming,
    error: error || runsError || sessionsError,
    activeRunId,
    streamingRunId,
    latestRunId,
    approvals,
    resetApprovals,
    loadMoreHistory,
  };
}
