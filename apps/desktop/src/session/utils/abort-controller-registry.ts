/**
 * Tracks in-flight request AbortControllers keyed by request id, so every
 * tracked request can be aborted on teardown (unmount, project switch, reset),
 * plus cancel intents for creates in flight.
 *
 * Two distinct cancellation shapes live here on purpose:
 * - `abort(key)` / `abortAll()` tear down the fetch itself. The server runs
 *   creation detached from the request, so aborting only discards the
 *   response; the run keeps going and surfaces via the task stream.
 * - `requestCancel(key)` records a Stop pressed during the create window.
 *   The fetch is left alive because its response carries the only handle to
 *   the run being created; the sender consumes the intent when the response
 *   arrives and cancels that run via RPC.
 *
 * One instance is held per session view in a ref; it owns no React state.
 */
export class AbortControllerRegistry {
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelRequested = new Set<string>();

  /** Start tracking a new request, aborting any prior one with the same key. */
  create(key: string): AbortController {
    this.abort(key);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return controller;
  }

  /** Abort and forget the request with this key, if still tracked. */
  abort(key: string): void {
    this.cancelRequested.delete(key);
    const controller = this.controllers.get(key);
    if (!controller) return;
    controller.abort();
    this.controllers.delete(key);
  }

  /** Stop tracking a finished request without aborting it. */
  release(key: string): void {
    this.controllers.delete(key);
    this.cancelRequested.delete(key);
  }

  /** Abort and forget every tracked request. */
  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.cancelRequested.clear();
  }

  /**
   * Record that the run being created by this in-flight request should be
   * cancelled as soon as it exists. No-op when the request is not tracked
   * anymore (already settled or aborted).
   */
  requestCancel(key: string): void {
    if (this.controllers.has(key)) {
      this.cancelRequested.add(key);
    }
  }

  /** Consume a recorded cancel intent, returning whether one existed. */
  consumeCancelRequest(key: string): boolean {
    const requested = this.cancelRequested.has(key);
    this.cancelRequested.delete(key);
    return requested;
  }
}

/** Whether an error is the result of an aborted fetch (user cancellation). */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) &&
    error.name === "AbortError"
  );
}
