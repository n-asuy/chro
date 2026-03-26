/**
 * Hook for streaming task run diffs via WebSocket.
 *
 * - Dedicated /rpc/task-runs/:id/diff WebSocket
 * - JSON Patch payloads with { type: "DIFF", content } entries
 * - Optional stats_only mode for summary views
 */
import { useCallback, useMemo } from "react";
import { getBackendBaseUrl } from "@/lib/backend-client";
import type { ApprovalRecord } from "../types/api";
import type { DiffContent } from "./use-task-log-stream";
import { useJsonPatchWsStream } from "./use-json-patch-ws-stream";

type DiffPatchEntry = {
  type: "DIFF";
  content: DiffContent;
};

type DiffStreamState = {
  diffs: Record<string, DiffPatchEntry | DiffContent>;
  approvals: Record<string, ApprovalRecord>;
};

interface UseDiffStreamParams {
  taskRunId: string | null;
  enabled?: boolean;
  statsOnly?: boolean;
}

export interface UseDiffStreamResult {
  diffs: Record<string, DiffContent>;
  error: string | null;
  isConnected: boolean;
}

export function useDiffStream({
  taskRunId,
  enabled = true,
  statsOnly,
}: UseDiffStreamParams): UseDiffStreamResult {
  const endpoint = useMemo(() => {
    if (!taskRunId) return undefined;
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    const basePath = `${baseUrl}/rpc/task-runs/${encodeURIComponent(taskRunId)}/diff`;
    if (typeof statsOnly === "boolean") {
      const params = new URLSearchParams();
      params.set("stats_only", String(statsOnly));
      return `${basePath}?${params.toString()}`;
    }
    return basePath;
  }, [taskRunId, statsOnly]);

  const initialData = useCallback(
    (): DiffStreamState => ({ diffs: {}, approvals: {} }),
    [],
  );

  const { data, error, isConnected } = useJsonPatchWsStream<DiffStreamState>(
    endpoint,
    enabled && !!taskRunId,
    initialData,
  );

  const diffs = useMemo(() => {
    const entries = data?.diffs ?? {};
    const output: Record<string, DiffContent> = {};

    for (const [path, entry] of Object.entries(entries)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if ("type" in entry && entry.type === "DIFF") {
        output[path] = entry.content;
        continue;
      }
      if ("change" in entry) {
        output[path] = entry as DiffContent;
      }
    }

    return output;
  }, [data?.diffs]);

  return { diffs, error, isConnected };
}
