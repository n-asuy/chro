import type { RouterHistory } from "@tanstack/react-router";
import { create } from "zustand";

type HistoryAction = Parameters<
  Parameters<RouterHistory["subscribe"]>[0]
>[0]["action"]["type"];

/**
 * Where the current entry sits in the window's history stack, and how far
 * the stack reaches. The browser exposes neither the forward length nor the
 * position, so `last` is derived from the router's per-entry `__TSR_index`
 * and the action that produced each entry.
 */
export type HistorySpan = {
  index: number;
  last: number;
};

export function initialHistorySpan(index: number): HistorySpan {
  // Entries ahead of a reloaded entry are unknowable; assume none.
  return { index, last: index };
}

export function nextHistorySpan(
  span: HistorySpan,
  action: HistoryAction,
  index: number,
): HistorySpan {
  // A push truncates everything ahead of it; traversals and replaces keep it.
  const last = action === "PUSH" ? index : Math.max(span.last, index);
  return { index, last };
}

export const canGoBack = (span: HistorySpan): boolean => span.index > 0;

export const canGoForward = (span: HistorySpan): boolean =>
  span.index < span.last;

interface HistorySpanStore {
  span: HistorySpan;
  record: (action: HistoryAction, index: number) => void;
}

/**
 * App-wide history span, fed by `NavigationHandler` (mounted at the root so no
 * navigation is missed) and read by the header's back/forward buttons.
 */
export const useHistorySpanStore = create<HistorySpanStore>((set) => ({
  span: initialHistorySpan(0),
  record: (action, index) =>
    set((s) => ({ span: nextHistorySpan(s.span, action, index) })),
}));
