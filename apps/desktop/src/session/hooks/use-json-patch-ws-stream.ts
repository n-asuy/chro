/**
 * Generic hook for consuming WebSocket streams that send JSON Patch messages.
 *
 * This is a thin, render-friendly view over the shared
 * {@link ./json-patch-stream-registry}: the actual socket, reconnect backoff,
 * first-message watchdog and patch application are owned by the registry and
 * shared per endpoint, so any number of components subscribing to the same URL
 * share ONE connection. Two consumers of the same stream see the same data
 * (the second one immediately, from the shared cache), and a consumer
 * unmounting never resets the shared state.
 */
import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  DISABLED_SNAPSHOT,
  type JsonPatchStreamSnapshot,
  type UseJsonPatchWsStreamOptions,
  acquireStream,
  forceCloseStream,
  getStreamSnapshot,
} from "./json-patch-stream-registry";

export type {
  LogEntryMessage,
  UseJsonPatchWsStreamOptions,
} from "./json-patch-stream-registry";

export interface UseJsonPatchWsStreamResult<T> {
  data: T | undefined;
  isConnected: boolean;
  error: string | null;
  /**
   * Force the underlying shared stream to close. Affects every consumer of the
   * same endpoint; normal teardown is ref-counted and automatic.
   */
  close: () => void;
}

/**
 * @param endpoint - WebSocket endpoint URL (http/https is converted to ws/wss)
 * @param enabled - Whether the subscription should be active
 * @param initialData - Factory for the initial document patches are applied to
 * @param options - Optional per-consumer callbacks for non-patch messages
 */
export function useJsonPatchWsStream<T extends object>(
  endpoint: string | undefined,
  enabled: boolean,
  initialData: () => T,
  options?: UseJsonPatchWsStreamOptions<T>,
): UseJsonPatchWsStreamResult<T> {
  const key = enabled && endpoint ? endpoint : undefined;

  const initialDataRef = useRef(initialData);
  initialDataRef.current = initialData;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const subscribe = useCallback(
    (notify: () => void) => {
      if (!key) return () => {};
      return acquireStream(key, () => initialDataRef.current(), {
        notify,
        getOptions: () =>
          optionsRef.current as UseJsonPatchWsStreamOptions | undefined,
      });
    },
    [key],
  );

  const getSnapshot = useCallback(
    (): JsonPatchStreamSnapshot<T> =>
      key
        ? getStreamSnapshot<T>(key)
        : (DISABLED_SNAPSHOT as JsonPatchStreamSnapshot<T>),
    [key],
  );

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const close = useCallback(() => {
    if (key) forceCloseStream(key);
  }, [key]);

  return {
    data: snapshot.data,
    isConnected: snapshot.isConnected,
    error: snapshot.error,
    close,
  };
}
