import { describe, expect, it } from "vitest";
import {
  AbortControllerRegistry,
  isAbortError,
} from "../abort-controller-registry";

describe("AbortControllerRegistry", () => {
  it("creates a live, non-aborted controller for a key", () => {
    const registry = new AbortControllerRegistry();
    const controller = registry.create("req-1");
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts the controller for a key", () => {
    const registry = new AbortControllerRegistry();
    const controller = registry.create("req-1");
    registry.abort("req-1");
    expect(controller.signal.aborted).toBe(true);
  });

  it("aborts a stale controller when the same key is reused", () => {
    const registry = new AbortControllerRegistry();
    const first = registry.create("req-1");
    const second = registry.create("req-1");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it("releases a key without aborting it", () => {
    const registry = new AbortControllerRegistry();
    const controller = registry.create("req-1");
    registry.release("req-1");
    registry.abort("req-1");
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts every tracked controller", () => {
    const registry = new AbortControllerRegistry();
    const a = registry.create("a");
    const b = registry.create("b");
    registry.abortAll();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it("records a cancel intent for an in-flight request without aborting it", () => {
    const registry = new AbortControllerRegistry();
    const controller = registry.create("req-1");
    registry.requestCancel("req-1");
    expect(controller.signal.aborted).toBe(false);
    expect(registry.consumeCancelRequest("req-1")).toBe(true);
  });

  it("consumes a cancel intent exactly once", () => {
    const registry = new AbortControllerRegistry();
    registry.create("req-1");
    registry.requestCancel("req-1");
    expect(registry.consumeCancelRequest("req-1")).toBe(true);
    expect(registry.consumeCancelRequest("req-1")).toBe(false);
  });

  it("ignores cancel intents for untracked requests", () => {
    const registry = new AbortControllerRegistry();
    registry.requestCancel("never-created");
    expect(registry.consumeCancelRequest("never-created")).toBe(false);

    const registry2 = new AbortControllerRegistry();
    registry2.create("req-1");
    registry2.release("req-1");
    registry2.requestCancel("req-1");
    expect(registry2.consumeCancelRequest("req-1")).toBe(false);
  });

  it("drops the cancel intent when the request is aborted or released", () => {
    const registry = new AbortControllerRegistry();
    registry.create("req-1");
    registry.requestCancel("req-1");
    registry.abort("req-1");
    expect(registry.consumeCancelRequest("req-1")).toBe(false);

    registry.create("req-2");
    registry.requestCancel("req-2");
    registry.release("req-2");
    expect(registry.consumeCancelRequest("req-2")).toBe(false);

    registry.create("req-3");
    registry.requestCancel("req-3");
    registry.abortAll();
    expect(registry.consumeCancelRequest("req-3")).toBe(false);
  });
});

describe("isAbortError", () => {
  it("recognizes a DOMException AbortError", () => {
    expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("recognizes an Error named AbortError", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError("nope")).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
