/**
 * Generic WebSocket JSON Patch streaming hook.
 *
 * - Uses dataRef + structuredClone for immutable patch application
 * - Uses rfc6902 library for RFC 6902 JSON Patch application
 * - Exponential backoff for reconnection (1s, 2s, 4s, 8s max)
 * - Handles finished signal to prevent reconnection
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { applyPatch } from "rfc6902";
import type { Operation } from "rfc6902";

/**
 * LogEntry message types from Chro server
 */
export type LogEntryMessage =
  | { type: "json_patch"; payload: Operation[] }
  | { type: "stdout"; payload: string }
  | { type: "stderr"; payload: string }
  | { type: "session_id"; payload: string }
  | { type: "ui_event"; payload: { kind: string; data?: unknown } }
  | { type: "user_prompt"; payload: string }
  | { type: "finished" };

export interface UseJsonPatchWsStreamOptions<T> {
  /** Called with each non-patch message (stdout, stderr, session_id, etc.) */
  onMessage?: (msg: LogEntryMessage) => void;
  /** Called once when finished event is received */
  onFinished?: () => void;
  /** Called on connection error */
  onError?: (error: string) => void;
  /** Called on successful connection */
  onConnect?: () => void;
}

export interface UseJsonPatchWsStreamResult<T> {
  data: T | undefined;
  isConnected: boolean;
  error: string | null;
  close: () => void;
}

const httpToWs = (url: string): string =>
  url.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

/**
 * Generic hook for consuming WebSocket streams that send JSON Patch messages.
 *
 * @param endpoint - WebSocket endpoint URL (can be http/https, will be converted)
 * @param enabled - Whether the connection should be active
 * @param initialData - Factory function to create initial data state
 * @param options - Optional callbacks for message handling
 */
export function useJsonPatchWsStream<T extends object>(
  endpoint: string | undefined,
  enabled: boolean,
  initialData: () => T,
  options?: UseJsonPatchWsStreamOptions<T>,
): UseJsonPatchWsStreamResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dataRef = useRef<T | undefined>(undefined);
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef<number>(0);
  const finishedRef = useRef<boolean>(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const scheduleReconnect = useCallback(() => {
    if (retryTimerRef.current) return;
    const attempt = retryCountRef.current;
    const delay = Math.min(8000, 1000 * Math.pow(2, attempt));
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setRetryNonce((n) => n + 1);
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
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (!enabled || !endpoint) {
      closeWebSocket();
      retryCountRef.current = 0;
      finishedRef.current = false;
      setData(undefined);
      setError(null);
      dataRef.current = undefined;
      return;
    }

    if (!dataRef.current) {
      dataRef.current = initialData();
    }

    if (!wsRef.current) {
      finishedRef.current = false;

      const wsEndpoint = httpToWs(endpoint);
      const ws = new WebSocket(wsEndpoint);

      ws.onopen = () => {
        setError(null);
        setIsConnected(true);
        retryCountRef.current = 0;
        if (retryTimerRef.current) {
          window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
        optionsRef.current?.onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as LogEntryMessage;

          if (msg.type === "json_patch") {
            const patches: Operation[] = msg.payload;
            const current = dataRef.current;
            if (!patches.length || !current) return;

            const next = structuredClone(current);
            applyPatch(next, patches);

            dataRef.current = next;
            setData(next);
          } else if (msg.type === "finished") {
            finishedRef.current = true;
            optionsRef.current?.onFinished?.();
            ws.close(1000, "finished");
            wsRef.current = null;
            setIsConnected(false);
          } else {
            optionsRef.current?.onMessage?.(msg);
          }
        } catch (err) {
          console.error(
            "[useJsonPatchWsStream] Failed to process message:",
            err,
          );
          setError("Failed to process stream update");
        }
      };

      ws.onerror = () => {
        const errorMsg = "Connection failed";
        setError(errorMsg);
        optionsRef.current?.onError?.(errorMsg);
      };

      ws.onclose = (evt) => {
        setIsConnected(false);
        wsRef.current = null;

        if (finishedRef.current || (evt?.code === 1000 && evt?.wasClean)) {
          return;
        }

        retryCountRef.current += 1;
        scheduleReconnect();
      };

      wsRef.current = ws;
    }

    return () => {
      closeWebSocket();
      finishedRef.current = false;
      dataRef.current = undefined;
      setData(undefined);
    };
  }, [
    endpoint,
    enabled,
    initialData,
    scheduleReconnect,
    closeWebSocket,
    retryNonce,
  ]);

  return {
    data,
    isConnected,
    error,
    close: closeWebSocket,
  };
}
