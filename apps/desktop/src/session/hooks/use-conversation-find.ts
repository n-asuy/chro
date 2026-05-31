/**
 * Drives the find-in-conversation feature: owns the query/open state, searches
 * the rendered conversation DOM, paints matches via the CSS Custom Highlight
 * API and navigates between them. Mirrors the file editor's find UX (the shared
 * FindBar) but targets arbitrary rendered React content instead of CodeMirror.
 */

import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  clearHighlightRanges,
  collectMatchRanges,
  setHighlightRanges,
} from "../utils/conversation-find-highlighter";

interface UseConversationFindOptions {
  /** Whether a conversation is present and searchable. */
  enabled: boolean;
  /** Scroll container holding the rendered conversation entries. */
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** Session pane root; scopes the open shortcut so other panes are unaffected. */
  rootRef: RefObject<HTMLElement | null>;
  /** Changes whenever the conversation entries change, to retrigger search. */
  recomputeKey: unknown;
  /** When this changes (e.g. active task switch), the bar folds away. */
  resetKey?: unknown;
}

export interface ConversationFindController {
  isOpen: boolean;
  query: string;
  /** "current/total" label, or null when there is nothing to show. */
  matchLabel: string | null;
  /** True while an active query should force the full conversation to render. */
  searchActive: boolean;
  /** Bumped to re-focus the bar's input when already open. */
  focusSignal: number;
  open: () => void;
  close: () => void;
  setQuery: (query: string) => void;
  next: () => void;
  previous: () => void;
}

export function useConversationFind({
  enabled,
  scrollContainerRef,
  rootRef,
  recomputeKey,
  resetKey,
}: UseConversationFindOptions): ConversationFindController {
  const idRef = useRef<symbol>(Symbol("conversation-find"));
  const prevResetKeyRef = useRef(resetKey);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);

  const rangesRef = useRef<Range[]>([]);
  const activeIndexRef = useRef(0);
  const queryRef = useRef("");
  queryRef.current = query;
  // Whether the user has stepped to a match for the current query yet. Until
  // they do, the first Enter/▼ selects the first match rather than skipping it.
  const hasNavigatedRef = useRef(false);

  const trimmedQuery = query.trim();
  const searchActive = isOpen && trimmedQuery.length > 0;

  const paint = useCallback(() => {
    const index = activeIndexRef.current;
    setHighlightRanges(
      idRef.current,
      rangesRef.current,
      rangesRef.current[index] ?? null,
    );
  }, []);

  const recompute = useCallback(() => {
    const container = scrollContainerRef.current;
    const q = queryRef.current.trim();
    if (!container || !q) {
      rangesRef.current = [];
      setMatchCount(0);
      clearHighlightRanges(idRef.current);
      return;
    }
    const ranges = collectMatchRanges(container, q);
    rangesRef.current = ranges;
    setMatchCount(ranges.length);

    let index = activeIndexRef.current;
    if (index > ranges.length - 1) index = ranges.length - 1;
    if (index < 0) index = 0;
    activeIndexRef.current = index;
    setActiveIndex(index);
    paint();
  }, [scrollContainerRef, paint]);

  const scrollToActive = useCallback(() => {
    const range = rangesRef.current[activeIndexRef.current];
    const target = range?.startContainer.parentElement;
    target?.scrollIntoView({ block: "center", behavior: "auto" });
  }, []);

  const selectIndex = useCallback(
    (index: number) => {
      activeIndexRef.current = index;
      setActiveIndex(index);
      paint();
      scrollToActive();
    },
    [paint, scrollToActive],
  );

  const next = useCallback(() => {
    const count = rangesRef.current.length;
    if (count === 0) return;
    if (!hasNavigatedRef.current) {
      hasNavigatedRef.current = true;
      selectIndex(0);
      return;
    }
    selectIndex((activeIndexRef.current + 1) % count);
  }, [selectIndex]);

  const previous = useCallback(() => {
    const count = rangesRef.current.length;
    if (count === 0) return;
    if (!hasNavigatedRef.current) {
      hasNavigatedRef.current = true;
      selectIndex(count - 1);
      return;
    }
    selectIndex((activeIndexRef.current - 1 + count) % count);
  }, [selectIndex]);

  const setQuery = useCallback((value: string) => {
    hasNavigatedRef.current = false;
    activeIndexRef.current = 0;
    setActiveIndex(0);
    setQueryState(value);
  }, []);

  const open = useCallback(() => {
    setIsOpen(true);
    setFocusSignal((n) => n + 1);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Recompute matches when the query, conversation, or open state changes.
  // Deferred to the next frame so any forced expansion of the virtualized list
  // is committed to the DOM first.
  useEffect(() => {
    if (!enabled || !isOpen || !trimmedQuery) {
      clearHighlightRanges(idRef.current);
      return;
    }
    const raf = requestAnimationFrame(recompute);
    return () => cancelAnimationFrame(raf);
  }, [enabled, isOpen, trimmedQuery, recomputeKey, recompute]);

  // Keep matches in sync as the conversation DOM mutates (streaming, expansion,
  // collapsible toggles) while the bar is open.
  useEffect(() => {
    if (!enabled || !isOpen || !trimmedQuery) return;
    const container = scrollContainerRef.current;
    if (!container || typeof MutationObserver === "undefined") return;

    let raf = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [enabled, isOpen, trimmedQuery, scrollContainerRef, recompute]);

  // Clear painted matches on unmount.
  useEffect(() => {
    const id = idRef.current;
    return () => clearHighlightRanges(id);
  }, []);

  // Open shortcut (Cmd/Ctrl+F), scoped to this session pane.
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        (event.key !== "f" && event.key !== "F")
      ) {
        return;
      }
      const root = rootRef.current;
      const target = event.target as Node | null;
      if (!root || (target && !root.contains(target))) return;
      event.preventDefault();
      event.stopPropagation();
      open();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [enabled, rootRef, open]);

  // If the conversation becomes unavailable, fold the bar away.
  useEffect(() => {
    if (!enabled) setIsOpen(false);
  }, [enabled]);

  // Fold the bar away when the host swaps conversations (e.g. task switch).
  useEffect(() => {
    if (prevResetKeyRef.current !== resetKey) {
      prevResetKeyRef.current = resetKey;
      setIsOpen(false);
    }
  }, [resetKey]);

  const matchLabel = trimmedQuery
    ? `${matchCount === 0 ? 0 : activeIndex + 1}/${matchCount}`
    : null;

  return {
    isOpen,
    query,
    matchLabel,
    searchActive,
    focusSignal,
    open,
    close,
    setQuery,
    next,
    previous,
  };
}
