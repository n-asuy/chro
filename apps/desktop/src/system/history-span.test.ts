import { describe, expect, it } from "vitest";
import {
  type HistorySpan,
  canGoBack,
  canGoForward,
  initialHistorySpan,
  nextHistorySpan,
} from "./history-span";

describe("history span", () => {
  it("starts with nothing ahead of the first entry", () => {
    const span = initialHistorySpan(0);
    expect(canGoBack(span)).toBe(false);
    expect(canGoForward(span)).toBe(false);
  });

  it("can go back but not forward after pushes", () => {
    let span = initialHistorySpan(0);
    span = nextHistorySpan(span, "PUSH", 1);
    span = nextHistorySpan(span, "PUSH", 2);
    expect(span).toEqual<HistorySpan>({ index: 2, last: 2 });
    expect(canGoBack(span)).toBe(true);
    expect(canGoForward(span)).toBe(false);
  });

  it("keeps the forward entries after going back", () => {
    let span = initialHistorySpan(0);
    span = nextHistorySpan(span, "PUSH", 1);
    span = nextHistorySpan(span, "PUSH", 2);
    span = nextHistorySpan(span, "BACK", 1);
    span = nextHistorySpan(span, "BACK", 0);
    expect(canGoBack(span)).toBe(false);
    expect(canGoForward(span)).toBe(true);
    span = nextHistorySpan(span, "FORWARD", 1);
    expect(canGoForward(span)).toBe(true);
    span = nextHistorySpan(span, "GO", 2);
    expect(canGoForward(span)).toBe(false);
  });

  it("drops the forward entries when a push branches off", () => {
    let span = initialHistorySpan(0);
    span = nextHistorySpan(span, "PUSH", 1);
    span = nextHistorySpan(span, "PUSH", 2);
    span = nextHistorySpan(span, "BACK", 1);
    span = nextHistorySpan(span, "PUSH", 2);
    expect(span).toEqual<HistorySpan>({ index: 2, last: 2 });
    expect(canGoForward(span)).toBe(false);
  });

  it("keeps the forward entries across a replace", () => {
    let span = initialHistorySpan(0);
    span = nextHistorySpan(span, "PUSH", 1);
    span = nextHistorySpan(span, "BACK", 0);
    span = nextHistorySpan(span, "REPLACE", 0);
    expect(canGoForward(span)).toBe(true);
  });

  it("can go back from a reloaded entry deep in the stack", () => {
    const span = initialHistorySpan(3);
    expect(canGoBack(span)).toBe(true);
    expect(canGoForward(span)).toBe(false);
  });
});
