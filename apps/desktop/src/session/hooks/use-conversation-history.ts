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
  createConversationFlattenCache,
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
import { dedupeJsonPatchOperations } from "../utils/json-patch-stream";
import { useTaskRunsStream } from "./use-task-runs-stream";
import { useTaskSessionsStream } from "./use-task-sessions-stream";

export interface UseConversationHistoryResult {
  entries: DisplayEntry[];
  isLoading: boolean;
  isStreaming: boolean;
  error: string | null;
  /** ID of the currently running TaskRun (if any) */
  activeRunId: string | null;
  /** ID of the most recent TaskRun (running or completed) */
  latestRunId: string | null;
  /** Approval records from the active run's log stream. */
  approvals: Record<string, ApprovalRecord>;
  /** Clear all approval records (e.g. after merge). */
  resetApprovals: () => void;
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

const MIN_INITIAL_HISTORY_ENTRIES = 10;
const REMAINING_HISTORY_BATCH_SIZE = 50;

function countLoadedEntries(states: Iterable<TaskRunEntriesState>): number {
  let total = 0;
  for (const state of states) {
    total += state.entries.length;
  }
  return total;
}

function sortRunsByCreatedAtAscending(
  taskRuns: TaskRunRecord[],
): TaskRunRecord[] {
  return [...taskRuns].sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
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

  const next = [...entries];
  const existingEntry = index < next.length ? next[index] : undefined;

  if (op.op === "remove") {
    if (index < next.length) {
      next.splice(index, 1);
    }
    return next;
  }

  if (!op.value) {
    return entries;
  }

  let displayEntry: DisplayEntry | null = null;
  if (op.value.type === "NORMALIZED_ENTRY") {
    displayEntry = createNormalizedDisplayEntry(
      op.value.content,
      taskRunId,
      existingEntry,
    );
  } else if (op.value.type === "STDOUT") {
    displayEntry = createStdoutDisplayEntry(
      op.value.content,
      taskRunId,
      existingEntry,
    );
  } else if (op.value.type === "STDERR") {
    displayEntry = createStderrDisplayEntry(
      op.value.content,
      taskRunId,
      existingEntry,
    );
  }

  if (!displayEntry) {
    return entries;
  }

  if (op.op === "add") {
    next.splice(index, 0, displayEntry);
  } else if (index < next.length) {
    next[index] = displayEntry;
  } else {
    next.push(displayEntry);
  }

  return next;
}

function applyEntriesPatches(
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
 * Returns a promise that resolves when the stream finishes.
 */
function loadHistoricTaskRunEntries(
  taskRunId: string,
  onEntries: (entries: DisplayEntry[]) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    const endpoint = httpToWs(
      `${baseUrl}/streams/task-runs/${encodeURIComponent(taskRunId)}/logs`,
    );
    const ws = new WebSocket(endpoint);
    let entries: DisplayEntry[] = [];
    let settled = false;

    const resolveWithEntries = () => {
      if (settled) return;
      settled = true;
      onEntries(entries);
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as LogEntryMessage;

        if (msg.JsonPatch) {
          entries = applyEntriesPatches(entries, msg.JsonPatch, taskRunId);
        }

        if (msg.finished) {
          resolveWithEntries();
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
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to load entries for TaskRun ${taskRunId}`));
    };

    ws.onclose = () => {
      // Some persisted runs have no replayable log entries. The server closes
      // those streams normally without a finished marker, so still unblock
      // history loading with whatever was replayed.
      resolveWithEntries();
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
): { close: () => void } {
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  const endpoint = httpToWs(
    `${baseUrl}/streams/task-runs/${encodeURIComponent(taskRunId)}/logs`,
  );
  const ws = new WebSocket(endpoint);
  let closed = false;
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
    if (!closed && evt?.code !== 1000) {
      recordPerfEvent("conv_stream_closed_unexpectedly", {
        task_run_id: taskRunId,
        close_code: evt?.code ?? null,
        was_clean: Boolean(evt?.wasClean),
        patch_messages: patchMessages,
      });
    }
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
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Approval records extracted from /approvals/* patches in the active stream
  const approvalsRef = useRef<Record<string, ApprovalRecord>>({});
  const [approvals, setApprovals] = useState<Record<string, ApprovalRecord>>(
    {},
  );

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

  const latestRunId = useMemo(() => {
    if (runs.length === 0) return null;
    const sorted = sortRunsByCreatedAtAscending(runs);
    return sorted[sorted.length - 1].id;
  }, [runs]);

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
    flattenCacheRef.current.clear();
    if (activeStreamRef.current) {
      activeStreamRef.current.close();
      activeStreamRef.current = null;
    }
    setIsLoading(Boolean(taskId));
    setIsStreaming(false);
    setError(null);
    setEntriesVersion(0);
    resetApprovals();
  }, [taskId, taskScopeId, sessionScopeId, resetApprovals]);

  // Effect 1: Load historic (finished) TaskRuns.
  // Uses cancelled flag — safe because historic loads are short-lived async ops.
  useEffect(() => {
    if (!enabled || !taskId || runsLoading) {
      if (!runsLoading) setIsLoading(false);
      return;
    }

    let cancelled = false;

    const loadHistoric = async () => {
      const sortedRuns = sortRunsByCreatedAtAscending(runs);
      const historicRuns = sortedRuns
        .filter(
          (r) =>
            r.status !== "running" &&
            r.id !== activeRunId &&
            !loadedRunIdsRef.current.has(r.id),
        )
        .reverse();

      if (historicRuns.length === 0) {
        setIsLoading(false);
        return;
      }

      let loaded = countLoadedEntries(taskRunEntriesRef.current.values());

      // Initial batch — newest first for fast render
      for (const run of historicRuns) {
        if (cancelled || loaded > MIN_INITIAL_HISTORY_ENTRIES) break;
        try {
          await loadHistoricTaskRunEntries(run.id, (entries) => {
            if (cancelled) return;
            taskRunEntriesRef.current.set(run.id, {
              taskRunId: run.id,
              createdAt: run.created_at,
              entries,
              finished: true,
            });
            loadedRunIdsRef.current.add(run.id);
            updateEntriesVersion();
          });
          loaded = countLoadedEntries(taskRunEntriesRef.current.values());
        } catch (err) {
          console.error(
            `[useConversationHistory] Failed to load TaskRun ${run.id}:`,
            err,
          );
        }
      }

      if (cancelled) return;
      setIsLoading(false);

      // Background batch — remaining runs
      let batchLoaded = 0;
      for (const run of historicRuns) {
        if (cancelled || loadedRunIdsRef.current.has(run.id)) continue;
        try {
          const before = countLoadedEntries(taskRunEntriesRef.current.values());
          await loadHistoricTaskRunEntries(run.id, (entries) => {
            if (cancelled) return;
            taskRunEntriesRef.current.set(run.id, {
              taskRunId: run.id,
              createdAt: run.created_at,
              entries,
              finished: true,
            });
            loadedRunIdsRef.current.add(run.id);
            updateEntriesVersion();
          });
          batchLoaded += Math.max(
            0,
            countLoadedEntries(taskRunEntriesRef.current.values()) - before,
          );
          if (batchLoaded >= REMAINING_HISTORY_BATCH_SIZE) {
            batchLoaded = 0;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } catch (err) {
          console.error(
            `[useConversationHistory] Failed to load TaskRun ${run.id}:`,
            err,
          );
        }
      }
    };

    loadHistoric();
    return () => {
      cancelled = true;
    };
  }, [enabled, taskId, runs, runsLoading, updateEntriesVersion]);

  // Effect 2: Stream the running TaskRun — fire-and-forget.
  // No cancelled flag. The stream is autonomous and survives effect re-runs.
  // Dedup via activeStreamRef prevents duplicate streams.
  // Depends on activeRunId (primitive), not runs (object reference).
  const activeRunCreatedAt =
    scopedPendingSubmission?.createdAt ?? wsActiveRun?.created_at ?? null;

  useEffect(() => {
    if (!enabled || !taskId) return;

    if (activeRunId && activeStreamRef.current?.runId !== activeRunId) {
      if (activeStreamRef.current) {
        activeStreamRef.current.close();
      }

      const createdAt = activeRunCreatedAt ?? new Date().toISOString();

      if (!taskRunEntriesRef.current.has(activeRunId)) {
        taskRunEntriesRef.current.set(activeRunId, {
          taskRunId: activeRunId,
          createdAt: createdAt,
          entries: [],
          finished: false,
        });
      }

      setIsStreaming(true);
      resetApprovals();

      const runId = activeRunId;
      const controller = streamRunningTaskRunEntries(
        runId,
        (patchOps) => {
          const state = taskRunEntriesRef.current.get(runId);
          if (state) {
            state.entries = applyEntriesPatches(state.entries, patchOps, runId);
            updateEntriesVersion();
          }
          applyApprovalPatches(patchOps);
        },
        () => {
          loadedRunIdsRef.current.add(runId);
          setIsStreaming(false);
          activeStreamRef.current = null;

          void loadHistoricTaskRunEntries(runId, (entries) => {
            taskRunEntriesRef.current.set(runId, {
              taskRunId: runId,
              createdAt: createdAt,
              entries,
              finished: true,
            });
            updateEntriesVersion();
          })
            .catch((err) => {
              console.error(
                `[useConversationHistory] Failed to replay finished TaskRun ${runId}:`,
                err,
              );
              const state = taskRunEntriesRef.current.get(runId);
              if (state) state.finished = true;
            })
            .finally(() => {
              callbacksRef.current?.onFinished?.();
              updateEntriesVersion();
            });
        },
      );

      activeStreamRef.current = { runId, close: controller.close };
    } else if (!activeRunId && activeStreamRef.current) {
      // activeRunId went null while streaming (e.g. pendingSubmission cleared
      // before log stream sent 'finished'). Finalize gracefully: close the
      // stream, mark the run as loaded, and reload finalized entries so we
      // don't lose the tail.
      const closingRunId = activeStreamRef.current.runId;
      const closingCreatedAt =
        taskRunEntriesRef.current.get(closingRunId)?.createdAt ??
        new Date().toISOString();
      activeStreamRef.current.close();
      activeStreamRef.current = null;
      setIsStreaming(false);
      loadedRunIdsRef.current.add(closingRunId);

      void loadHistoricTaskRunEntries(closingRunId, (entries) => {
        taskRunEntriesRef.current.set(closingRunId, {
          taskRunId: closingRunId,
          createdAt: closingCreatedAt,
          entries,
          finished: true,
        });
        updateEntriesVersion();
      })
        .catch((err) => {
          console.error(
            `[useConversationHistory] Failed to reload early-closed TaskRun ${closingRunId}:`,
            err,
          );
          const state = taskRunEntriesRef.current.get(closingRunId);
          if (state) state.finished = true;
        })
        .finally(() => {
          callbacksRef.current?.onFinished?.();
          updateEntriesVersion();
        });
    }
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
    if (isStreaming && activeRunId) {
      loadingRunIds.add(activeRunId);
    }
    if (pendingRunId && !scopedPendingSubmission?.finishedAt) {
      loadingRunIds.add(pendingRunId);
    }

    return flattenCacheRef.current.flatten(allStates, sessions, {
      promptOverridesByRun,
      loadingRunIds,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRunId,
    entriesVersion,
    isStreaming,
    scopedPendingSubmission,
    sessionScopeId,
    sessions,
  ]);

  return {
    entries,
    isLoading: isLoading || runsLoading || sessionsLoading,
    isStreaming,
    error: error || runsError || sessionsError,
    activeRunId,
    latestRunId,
    approvals,
    resetApprovals,
  };
}
