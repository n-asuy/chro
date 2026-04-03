import { getBackendBaseUrl } from "@/lib/backend-client";
import { recordPerfEvent } from "@/perf/recorder";
/**
 * Hook for streaming task run log entries via WebSocket.
 *
 * Uses /streams/task-runs/:id/logs endpoint for both history and live updates.
 * Handles LogEntry messages (JsonPatch, Finished).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRecord } from "../types/api";
import type { DisplayEntry, NormalizedEntry } from "../types/normalized";
import { dedupeJsonPatchOperations } from "../utils/json-patch-stream";

export type DiffChangeKind =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "copied"
  | "permission_change";

export type DiffContent = {
  change: DiffChangeKind;
  additions?: number;
  deletions?: number;
  old_content?: string;
  new_content?: string;
  old_path?: string;
  new_path?: string;
  content_omitted?: boolean;
  /** True when the file is binary (image, font, etc.). */
  is_binary?: boolean;
  /** Optional unified diff (if provided by server). */
  content?: string;
  /** Optional legacy alias for change. */
  kind?: DiffChangeKind;
};

export type DiffEntry = DiffContent;

export type PatchDocument = {
  diffs: Record<string, DiffEntry>;
  approvals: Record<string, ApprovalRecord>;
};

export type TaskRunPatchState = {
  entries: DisplayEntry[];
  document: PatchDocument;
};

export interface UseTaskRunStreamResult {
  entries: DisplayEntry[];
  document: PatchDocument;
  /** @deprecated Use isStreaming instead */
  isLoading: boolean;
  isStreaming: boolean;
  isConnected: boolean;
  error: string | null;
  resetEntries: () => void;
  resetDocument: () => void;
  closeSocket: () => void;
}

type TaskRunStatus = "running" | "completed" | "failed" | "pending";

interface UseTaskRunStreamCallbacks {
  onFinished?: () => void;
  onError?: (error: string) => void;
}

interface UseTaskRunStreamParams {
  taskRunId: string | null;
  status?: TaskRunStatus;
  callbacks?: UseTaskRunStreamCallbacks;
}

type ServerWireEntry = {
  timestamp?: string | null;
  type: { type: string; [key: string]: unknown };
  content: string;
  metadata?: Record<string, unknown>;
};

type PatchValue =
  | { type: "NORMALIZED_ENTRY"; content: ServerWireEntry }
  | { type: "STDOUT"; content: string }
  | { type: "STDERR"; content: string }
  | { type: "DIFF"; content: unknown };

type JsonPatchOperation = {
  op: "add" | "replace" | "remove";
  path: string;
  value?: PatchValue;
};

type LogEntryMessage = {
  JsonPatch?: JsonPatchOperation[];
  finished?: boolean;
};

let entryIdCounter = 0;
const generateEntryId = (): string => {
  entryIdCounter += 1;
  return `entry-${Date.now()}-${entryIdCounter}`;
};

const FIRST_PATCH_STALL_MS = 15_000;

function createNormalizedDisplayEntry(
  entry: ServerWireEntry,
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
    key: existing?.key ?? id,
  };
}

const isDiffChangeKind = (value: unknown): value is DiffChangeKind =>
  value === "added" ||
  value === "deleted" ||
  value === "modified" ||
  value === "renamed" ||
  value === "copied" ||
  value === "permission_change";

function normalizeDiffContent(
  value: unknown,
  fallbackPath: string,
): DiffContent | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;

  // Legacy shape: { path, content, status }
  if (typeof record.content === "string" && "status" in record) {
    const status = record.status;
    const change: DiffChangeKind = isDiffChangeKind(status)
      ? status
      : "modified";
    const path = typeof record.path === "string" ? record.path : fallbackPath;

    return {
      change,
      old_path: path,
      new_path: path,
      old_content: undefined,
      new_content: undefined,
      content_omitted: false,
      additions: undefined,
      deletions: undefined,
      content: record.content,
    };
  }

  const changeValue = record.change ?? record.kind;
  const change: DiffChangeKind = isDiffChangeKind(changeValue)
    ? changeValue
    : "modified";

  return {
    change,
    old_path: typeof record.old_path === "string" ? record.old_path : undefined,
    new_path: typeof record.new_path === "string" ? record.new_path : undefined,
    old_content:
      typeof record.old_content === "string" ? record.old_content : undefined,
    new_content:
      typeof record.new_content === "string" ? record.new_content : undefined,
    content_omitted:
      typeof record.content_omitted === "boolean"
        ? record.content_omitted
        : false,
    additions:
      typeof record.additions === "number" ? record.additions : undefined,
    deletions:
      typeof record.deletions === "number" ? record.deletions : undefined,
    content: typeof record.content === "string" ? record.content : undefined,
    kind: isDiffChangeKind(record.kind) ? record.kind : undefined,
  };
}

function normalizeDiffPatchValue(
  value: unknown,
  fallbackPath: string,
): DiffContent | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (record.type === "DIFF") {
    return normalizeDiffContent(record.content, fallbackPath);
  }
  return normalizeDiffContent(value, fallbackPath);
}

function createStdoutDisplayEntry(
  content: string,
  existing?: DisplayEntry,
): DisplayEntry {
  const key = existing?.key ?? generateEntryId();
  return {
    type: "STDOUT",
    content,
    key,
  };
}

function createStderrDisplayEntry(
  content: string,
  existing?: DisplayEntry,
): DisplayEntry {
  const key = existing?.key ?? generateEntryId();
  return {
    type: "STDERR",
    content,
    key,
  };
}

function createEmptyPatchDocument(): PatchDocument {
  return {
    diffs: {},
    approvals: {},
  };
}

function createEmptyTaskRunPatchState(): TaskRunPatchState {
  return {
    entries: [],
    document: createEmptyPatchDocument(),
  };
}

export function applyTaskRunPatchOperations(
  state: TaskRunPatchState,
  ops: JsonPatchOperation[],
): TaskRunPatchState {
  const dedupedOps = dedupeJsonPatchOperations(ops);
  const entryOps = dedupedOps.filter((op) => /^\/entries\/\d+$/.test(op.path));
  const documentOps = dedupedOps.filter(
    (op) => !/^\/entries\/\d+$/.test(op.path),
  );

  let nextEntries = state.entries;
  if (entryOps.length > 0) {
    nextEntries = [...state.entries];

    for (const op of entryOps) {
      const entriesMatch = op.path.match(/^\/entries\/(\d+)$/);
      if (!entriesMatch) {
        continue;
      }

      const index = Number.parseInt(entriesMatch[1], 10);
      if (Number.isNaN(index)) {
        continue;
      }

      const existingEntry =
        index < nextEntries.length ? nextEntries[index] : undefined;

      switch (op.op) {
        case "add":
        case "replace": {
          if (!op.value) {
            continue;
          }

          let displayEntry: DisplayEntry | null = null;

          if (op.value.type === "NORMALIZED_ENTRY") {
            displayEntry = createNormalizedDisplayEntry(
              op.value.content,
              existingEntry,
            );
          } else if (op.value.type === "STDOUT") {
            displayEntry = createStdoutDisplayEntry(
              op.value.content,
              existingEntry,
            );
          } else if (op.value.type === "STDERR") {
            displayEntry = createStderrDisplayEntry(
              op.value.content,
              existingEntry,
            );
          }

          if (!displayEntry) {
            continue;
          }

          if (op.op === "add") {
            nextEntries.splice(index, 0, displayEntry);
          } else if (index < nextEntries.length) {
            nextEntries[index] = displayEntry;
          } else {
            nextEntries.push(displayEntry);
          }
          break;
        }
        case "remove": {
          if (index < nextEntries.length) {
            nextEntries.splice(index, 1);
          }
          break;
        }
      }
    }
  }

  let nextDocument = state.document;
  if (documentOps.length > 0) {
    const document: PatchDocument = {
      diffs: { ...state.document.diffs },
      approvals: { ...state.document.approvals },
    };
    let documentChanged = false;

    for (const op of documentOps) {
      const segments = op.path.split("/").filter(Boolean);

      if (segments[0] === "diffs" && segments.length >= 2) {
        const diffPath = segments.slice(1).join("/");
        if (op.op === "remove") {
          if (diffPath in document.diffs) {
            delete document.diffs[diffPath];
            documentChanged = true;
          }
          continue;
        }

        if (op.value === undefined) {
          continue;
        }

        const normalized = normalizeDiffPatchValue(op.value, diffPath);
        if (!normalized) {
          continue;
        }

        document.diffs[diffPath] = normalized;
        documentChanged = true;
        continue;
      }

      if (segments[0] === "approvals" && segments.length >= 2) {
        const approvalId = segments[1];
        if (op.op === "remove") {
          if (approvalId in document.approvals) {
            delete document.approvals[approvalId];
            documentChanged = true;
          }
          continue;
        }

        if (op.value === undefined) {
          continue;
        }

        document.approvals[approvalId] = op.value as unknown as ApprovalRecord;
        documentChanged = true;
      }
    }

    if (documentChanged) {
      nextDocument = document;
    }
  }

  return {
    entries: nextEntries,
    document: nextDocument,
  };
}

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

export function useTaskRunStream({
  taskRunId,
  status = "running",
  callbacks,
}: UseTaskRunStreamParams): UseTaskRunStreamResult {
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [document, setDocument] = useState<PatchDocument>(
    createEmptyPatchDocument,
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef<number>(0);
  const finishedRef = useRef<boolean>(false);
  const connectedAtRef = useRef<number | null>(null);
  const firstPatchSeenRef = useRef(false);
  const firstPatchTimerRef = useRef<number | null>(null);
  const patchMessagesRef = useRef(0);
  const patchOpsRef = useRef(0);
  const entriesRef = useRef(entries);
  const documentRef = useRef(document);
  const currentTaskRunIdRef = useRef<string | null>(taskRunId);
  const [retryNonce, setRetryNonce] = useState(0);

  entriesRef.current = entries;
  documentRef.current = document;

  const endpoint = useMemo(() => {
    if (!taskRunId) return undefined;
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    return `${baseUrl}/streams/task-runs/${encodeURIComponent(taskRunId)}/logs`;
  }, [taskRunId]);

  const applyCustomPatches = useCallback(
    (ops: JsonPatchOperation[], replace = false) => {
      const next = applyTaskRunPatchOperations(
        replace
          ? createEmptyTaskRunPatchState()
          : {
              entries: entriesRef.current,
              document: documentRef.current,
            },
        ops,
      );

      entriesRef.current = next.entries;
      documentRef.current = next.document;
      setEntries(next.entries);
      setDocument(next.document);
    },
    [],
  );

  const resetEntriesState = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  const resetDocumentState = useCallback(() => {
    const next = createEmptyPatchDocument();
    documentRef.current = next;
    setDocument(next);
  }, []);

  const resetTaskRunState = useCallback(() => {
    resetEntriesState();
    resetDocumentState();
  }, [resetDocumentState, resetEntriesState]);

  const scheduleReconnect = useCallback(() => {
    if (retryTimerRef.current) return;
    const attempt = retryCountRef.current;
    const delay = Math.min(8000, 1000 * 2 ** attempt);
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryNonce((n: number) => n + 1);
    }, delay);
  }, []);

  const closeWebSocket = useCallback(() => {
    if (wsRef.current) {
      const ws = wsRef.current;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
      wsRef.current = null;
    }
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (firstPatchTimerRef.current) {
      window.clearTimeout(firstPatchTimerRef.current);
      firstPatchTimerRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    let pendingOps: JsonPatchOperation[] = [];
    let rafId: number | null = null;
    let cancelled = false;

    if (!taskRunId || !endpoint) {
      currentTaskRunIdRef.current = taskRunId;
      closeWebSocket();
      retryCountRef.current = 0;
      finishedRef.current = false;
      resetTaskRunState();
      setIsStreaming(false);
      setError(null);
      return;
    }

    const taskRunChanged = currentTaskRunIdRef.current !== taskRunId;
    currentTaskRunIdRef.current = taskRunId;

    if (taskRunChanged) {
      resetTaskRunState();
      retryCountRef.current = 0;
      finishedRef.current = false;
    }

    setIsStreaming(status === "running");
    connectedAtRef.current = null;
    firstPatchSeenRef.current = false;
    patchMessagesRef.current = 0;
    patchOpsRef.current = 0;
    if (firstPatchTimerRef.current) {
      window.clearTimeout(firstPatchTimerRef.current);
      firstPatchTimerRef.current = null;
    }

    if (!wsRef.current) {
      finishedRef.current = false;
      const capturedTaskRunId = taskRunId;
      const isReconnect = retryCountRef.current > 0;
      let pendingReplace = isReconnect;

      const flushPendingOps = () => {
        rafId = null;
        if (pendingOps.length === 0) {
          return;
        }

        const ops = pendingOps;
        pendingOps = [];
        applyCustomPatches(ops, pendingReplace);
        pendingReplace = false;
      };

      const wsEndpoint = httpToWs(endpoint);
      const ws = new WebSocket(wsEndpoint);

      ws.onopen = () => {
        if (cancelled || currentTaskRunIdRef.current !== capturedTaskRunId) {
          ws.close();
          return;
        }

        setError(null);
        setIsConnected(true);
        connectedAtRef.current = performance.now();
        recordPerfEvent("task_run_stream_opened", {
          task_run_id: taskRunId,
          status,
        });
        if (status === "running") {
          firstPatchTimerRef.current = window.setTimeout(() => {
            if (!firstPatchSeenRef.current) {
              recordPerfEvent("task_run_stream_stalled", {
                task_run_id: taskRunId,
                timeout_ms: FIRST_PATCH_STALL_MS,
              });
            }
          }, FIRST_PATCH_STALL_MS);
        }
        retryCountRef.current = 0;
        if (retryTimerRef.current) {
          window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        if (cancelled || currentTaskRunIdRef.current !== capturedTaskRunId) {
          return;
        }

        try {
          const msg = JSON.parse(event.data) as LogEntryMessage;

          if (msg.JsonPatch) {
            patchMessagesRef.current += 1;
            patchOpsRef.current += msg.JsonPatch.length;
            const hasEntryPatch = msg.JsonPatch.some(
              (op) => /^\/entries\/\d+$/.test(op.path) && op.op !== "remove",
            );
            if (hasEntryPatch && !firstPatchSeenRef.current) {
              firstPatchSeenRef.current = true;
              if (firstPatchTimerRef.current) {
                window.clearTimeout(firstPatchTimerRef.current);
                firstPatchTimerRef.current = null;
              }
              const connectedAt = connectedAtRef.current;
              recordPerfEvent("task_run_first_patch", {
                task_run_id: taskRunId,
                time_to_first_patch_ms:
                  connectedAt === null
                    ? null
                    : Math.round((performance.now() - connectedAt) * 100) / 100,
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
            finishedRef.current = true;
            setIsStreaming(false);
            const connectedAt = connectedAtRef.current;
            if (firstPatchTimerRef.current) {
              window.clearTimeout(firstPatchTimerRef.current);
              firstPatchTimerRef.current = null;
            }
            recordPerfEvent("task_run_stream_finished", {
              task_run_id: taskRunId,
              elapsed_ms:
                connectedAt === null
                  ? null
                  : Math.round((performance.now() - connectedAt) * 100) / 100,
              patch_messages: patchMessagesRef.current,
              patch_ops: patchOpsRef.current,
            });
            callbacksRef.current?.onFinished?.();
            ws.close(1000, "finished");
            wsRef.current = null;
            setIsConnected(false);
          }
        } catch (err) {
          console.error("[useTaskRunStream] Failed to process message:", err);
          recordPerfEvent("task_run_stream_message_error", {
            task_run_id: taskRunId,
          });
          setError("Failed to process stream update");
        }
      };

      ws.onerror = () => {
        if (cancelled || currentTaskRunIdRef.current !== capturedTaskRunId) {
          return;
        }

        const errorMsg = "Connection failed";
        recordPerfEvent("task_run_stream_error", {
          task_run_id: taskRunId,
          error: errorMsg,
        });
        setError(errorMsg);
        callbacksRef.current?.onError?.(errorMsg);
      };

      ws.onclose = (evt) => {
        if (cancelled || currentTaskRunIdRef.current !== capturedTaskRunId) {
          return;
        }

        setIsConnected(false);
        wsRef.current = null;

        if (finishedRef.current || (evt?.code === 1000 && evt?.wasClean)) {
          return;
        }

        recordPerfEvent("task_run_stream_closed_unexpectedly", {
          task_run_id: taskRunId,
          close_code: evt?.code ?? null,
          was_clean: Boolean(evt?.wasClean),
        });
        retryCountRef.current += 1;
        scheduleReconnect();
      };

      wsRef.current = ws;
    }

    return () => {
      cancelled = true;
      if (typeof rafId === "number") {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      closeWebSocket();
      finishedRef.current = false;
    };
  }, [
    taskRunId,
    endpoint,
    status,
    applyCustomPatches,
    scheduleReconnect,
    closeWebSocket,
    resetTaskRunState,
    retryNonce,
  ]);

  return {
    entries,
    document,
    isLoading: isStreaming,
    isStreaming,
    isConnected,
    error,
    resetEntries: resetEntriesState,
    resetDocument: resetDocumentState,
    closeSocket: closeWebSocket,
  };
}
