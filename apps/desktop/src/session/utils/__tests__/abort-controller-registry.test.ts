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
