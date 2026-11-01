import { getBackendBaseUrl } from "@/lib/backend-client";
import { useCallback, useMemo } from "react";
import { orderSessionQueue } from "../lib/session-queue";
import type { SessionQueueItem } from "../types";
import { useJsonPatchWsStream } from "./use-json-patch-ws-stream";

type SessionQueueState = {
  session_queue: Record<string, SessionQueueItem>;
};

/**
 * The session's queue, live: messages queued from the composer, the terminal
 * or by agents appear as they are queued and leave when they become a turn or are
 * withdrawn.
 */
export function useSessionQueueStream({
  taskId,
}: {
  taskId: string | null;
}): SessionQueueItem[] {
  const endpoint = useMemo(() => {
    if (!taskId) return undefined;
    const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
    return `${baseUrl}/streams/tasks/${encodeURIComponent(taskId)}/queue`;
  }, [taskId]);

  const initialData = useCallback(
    (): SessionQueueState => ({ session_queue: {} }),
    [],
  );

  const { data } = useJsonPatchWsStream<SessionQueueState>(
    endpoint,
    Boolean(taskId),
    initialData,
  );

  return useMemo(
    () => orderSessionQueue(data?.session_queue ?? {}, taskId),
    [data?.session_queue, taskId],
  );
}
