/**
 * Tracks in-flight request AbortControllers keyed by request id, so a specific
 * submission can be aborted (the user hits Stop before its run exists) and every
 * tracked request can be aborted on teardown (unmount, project switch, reset).
 *
 * One instance is held per session view in a ref; it owns no React state.
 */
export class AbortControllerRegistry {
  private readonly controllers = new Map<string, AbortController>();

  /** Start tracking a new request, aborting any prior one with the same key. */
  create(key: string): AbortController {
    this.abort(key);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return controller;
  }

  /** Abort and forget the request with this key, if still tracked. */
  abort(key: string): void {
    const controller = this.controllers.get(key);
    if (!controller) return;
    controller.abort();
    this.controllers.delete(key);
  }

  /** Stop tracking a finished request without aborting it. */
  release(key: string): void {
    this.controllers.delete(key);
  }

  /** Abort and forget every tracked request. */
  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
  }
}

/** Whether an error is the result of an aborted fetch (user cancellation). */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException || error instanceof Error) &&
    error.name === "AbortError"
  );
}
