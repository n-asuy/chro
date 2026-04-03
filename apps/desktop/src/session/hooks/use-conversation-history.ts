import { getBackendBaseUrl } from "@/lib/backend-client";
import { recordPerfEvent } from "@/perf/recorder";
/**
 * Hook for aggregating conversation history across all TaskRuns for a Task.
 *
 * User prompts come from task session metadata so follow-up turns remain
 * visible even if live log normalization drops a user_message patch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flattenConversationEntries } from "../domain/conversation-history";
import type { DisplayEntry, NormalizedEntry, TaskRunRecord } from "../types";
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
}

interface UseConversationHistoryParams {
  taskId: string | null;
  enabled?: boolean;
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

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as LogEntryMessage;

        if (msg.JsonPatch) {
          entries = applyEntriesPatches(entries, msg.JsonPatch, taskRunId);
        }

        if (msg.finished) {
          onEntries(entries);
          ws.close(1000, "finished");
          resolve();
        }
      } catch (err) {
        console.error(
          `[loadHistoricTaskRunEntries] Error processing message for ${taskRunId}:`,
          err,
        );
      }
    };

    ws.onerror = () => {
      reject(new Error(`Failed to load entries for TaskRun ${taskRunId}`));
    };

    ws.onclose = (evt) => {
      if (evt.code !== 1000) {
        // Abnormal close - still resolve with what we have
        onEntries(entries);
        resolve();
      }
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
  let rafId: number | null = null;

  const flushPendingOps = () => {
    rafId = null;
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
        if (rafId === null) {
          rafId = requestAnimationFrame(flushPendingOps);
        }
      }

      if (msg.finished) {
        if (rafId !== null) {
          cancelAnimationFrame(rafId);
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
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
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
  taskId,
  enabled = true,
  callbacks,
}: UseConversationHistoryParams): UseConversationHistoryResult {
  // State for entries from each TaskRun
  const taskRunEntriesRef = useRef<Map<string, TaskRunEntriesState>>(new Map());
  const [entriesVersion, setEntriesVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stream of TaskRuns for this Task
  const {
    runs,
    isLoading: runsLoading,
    error: runsError,
  } = useTaskRunsStream({
    taskId,
    enabled: enabled && !!taskId,
  });

  const {
    sessions,
    isLoading: sessionsLoading,
    error: sessionsError,
  } = useTaskSessionsStream({
    taskId,
    enabled: enabled && !!taskId,
  });

  // Track which TaskRuns we've loaded and which is actively streaming
  const loadedRunIdsRef = useRef<Set<string>>(new Set());
  const activeStreamRef = useRef<{ runId: string; close: () => void } | null>(
    null,
  );
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Find the running TaskRun (if any)
  const activeRun = useMemo(
    () => runs.find((r) => r.status === "running"),
    [runs],
  );
  const activeRunId = activeRun?.id ?? null;

  // Helper to update entries state (rAF-batched to avoid per-patch re-renders)
  const pendingVersionUpdateRef = useRef(false);
  const updateEntriesVersion = useCallback(() => {
    if (pendingVersionUpdateRef.current) return;
    pendingVersionUpdateRef.current = true;
    requestAnimationFrame(() => {
      pendingVersionUpdateRef.current = false;
      setEntriesVersion((v: number) => v + 1);
    });
  }, []);

  // Reset state when taskId changes
  useEffect(() => {
    taskRunEntriesRef.current.clear();
    loadedRunIdsRef.current.clear();
    if (activeStreamRef.current) {
      activeStreamRef.current.close();
      activeStreamRef.current = null;
    }
    setIsLoading(true);
    setIsStreaming(false);
    setError(null);
    setEntriesVersion(0);
  }, [taskId]);

  // Load historic TaskRuns and stream running TaskRun
  useEffect(() => {
    if (!enabled || !taskId || runsLoading) return;

    let cancelled = false;

    const loadAndStream = async () => {
      const loadStartedAt = performance.now();
      const sortedRuns = sortRunsByCreatedAtAscending(runs);

      const historicRuns = sortedRuns.filter(
        (r) => r.status !== "running" && !loadedRunIdsRef.current.has(r.id),
      );
      const newestHistoricRuns = [...historicRuns].reverse();
      const hasRunningRun = sortedRuns.some((r) => r.status === "running");

      if (historicRuns.length > 0 || hasRunningRun) {
        recordPerfEvent("conv_load_and_stream_start", {
          task_id: taskId,
          total_runs: sortedRuns.length,
          historic_to_load: historicRuns.length,
          has_running_run: hasRunningRun,
        });
      }

      const loadHistoricRun = async (run: TaskRunRecord): Promise<boolean> => {
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
          return true;
        } catch (err) {
          console.error(
            `[useConversationHistory] Failed to load TaskRun ${run.id}:`,
            err,
          );
          return false;
        }
      };

      let initialEntriesLoaded = countLoadedEntries(
        taskRunEntriesRef.current.values(),
      );
      let initialHistoricLoaded = 0;

      // Load the newest finished runs first so the session can render quickly.
      for (const run of newestHistoricRuns) {
        if (cancelled) break;
        if (initialEntriesLoaded > MIN_INITIAL_HISTORY_ENTRIES) break;

        const loaded = await loadHistoricRun(run);
        if (!loaded) continue;

        initialHistoricLoaded += 1;
        initialEntriesLoaded = countLoadedEntries(
          taskRunEntriesRef.current.values(),
        );
      }

      if (cancelled) return;
      setIsLoading(false);

      const initialHistoricLoadMs =
        Math.round((performance.now() - loadStartedAt) * 100) / 100;

      // Stream running TaskRun
      const runningRun = sortedRuns.find((r) => r.status === "running");
      if (runningRun && activeStreamRef.current?.runId !== runningRun.id) {
        recordPerfEvent("conv_running_stream_connect", {
          task_id: taskId,
          task_run_id: runningRun.id,
          historic_load_ms: initialHistoricLoadMs,
          historic_loaded: initialHistoricLoaded,
        });
        // Close previous stream if different
        if (activeStreamRef.current) {
          activeStreamRef.current.close();
        }

        // Initialize state for this run
        if (!taskRunEntriesRef.current.has(runningRun.id)) {
          taskRunEntriesRef.current.set(runningRun.id, {
            taskRunId: runningRun.id,
            createdAt: runningRun.created_at,
            entries: [],
            finished: false,
          });
        }

        setIsStreaming(true);

        const controller = streamRunningTaskRunEntries(
          runningRun.id,
          (patchOps) => {
            if (cancelled) return;
            const state = taskRunEntriesRef.current.get(runningRun.id);
            if (state) {
              state.entries = applyEntriesPatches(
                state.entries,
                patchOps,
                runningRun.id,
              );
              updateEntriesVersion();
            }
          },
          () => {
            if (cancelled) return;
            loadedRunIdsRef.current.add(runningRun.id);
            setIsStreaming(false);
            activeStreamRef.current = null;

            void loadHistoricTaskRunEntries(runningRun.id, (entries) => {
              if (cancelled) return;
              taskRunEntriesRef.current.set(runningRun.id, {
                taskRunId: runningRun.id,
                createdAt: runningRun.created_at,
                entries,
                finished: true,
              });
              updateEntriesVersion();
            })
              .catch((err) => {
                console.error(
                  `[useConversationHistory] Failed to replay finished TaskRun ${runningRun.id}:`,
                  err,
                );
                const state = taskRunEntriesRef.current.get(runningRun.id);
                if (state) {
                  state.finished = true;
                }
              })
              .finally(() => {
                if (cancelled) return;
                callbacksRef.current?.onFinished?.();
                updateEntriesVersion();
              });
          },
        );

        activeStreamRef.current = {
          runId: runningRun.id,
          close: controller.close,
        };
      } else if (!runningRun && activeStreamRef.current) {
        // No running run but we have an active stream - close it
        activeStreamRef.current.close();
        activeStreamRef.current = null;
        setIsStreaming(false);
      }

      let backgroundEntriesLoaded = 0;
      for (const run of newestHistoricRuns) {
        if (cancelled) break;
        if (loadedRunIdsRef.current.has(run.id)) continue;

        const beforeCount = countLoadedEntries(
          taskRunEntriesRef.current.values(),
        );
        const loaded = await loadHistoricRun(run);
        if (!loaded) continue;

        const afterCount = countLoadedEntries(
          taskRunEntriesRef.current.values(),
        );
        backgroundEntriesLoaded += Math.max(0, afterCount - beforeCount);

        if (backgroundEntriesLoaded >= REMAINING_HISTORY_BATCH_SIZE) {
          backgroundEntriesLoaded = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    loadAndStream();

    return () => {
      cancelled = true;
    };
  }, [enabled, taskId, runs, runsLoading, updateEntriesVersion]);

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
    const result = flattenConversationEntries(allStates, sessions);

    // Add loading indicator if streaming
    if (isStreaming) {
      result.push({
        type: "NORMALIZED_ENTRY",
        key: "loading-patch",
        content: {
          id: "loading-patch",
          timestamp: null,
          entry_type: { type: "loading" },
          content: "",
        },
      });
    }

    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesVersion, isStreaming, sessions]);

  return {
    entries,
    isLoading: isLoading || runsLoading || sessionsLoading,
    isStreaming,
    error: error || runsError || sessionsError,
    activeRunId,
  };
}
