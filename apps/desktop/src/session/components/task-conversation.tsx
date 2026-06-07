import { Loader2 } from "lucide-react";
import {
  type MutableRefObject,
  type RefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { ConversationEntries } from "../conversation-view";
import type { DisplayEntry } from "../types";
import {
  SESSION_SELECT_ACTIVE_ATTR,
  SESSION_SELECT_SCOPE_ATTR,
  activateSessionSelectScope,
  clearSessionSelectHighlight,
  clearSessionSelectState,
  getSelectedSessionText,
  isSelectAllShortcut,
  selectSessionMessages,
  selectionTouchesScope,
  shouldSelectSessionMessages,
  shouldUseNativeSelectAll,
} from "../utils/session-select-all";

const SCROLL_BOTTOM_THRESHOLD = 50;

const conversationScrollPositionCache = new Map<
  string,
  { scrollTop: number; scrollHeight: number; wasAtBottom: boolean }
>();

/**
 * TaskConversation renders precomputed conversation entries.
 *
 * Aggregation and pending-state reconciliation happen outside this component so
 * every surface can read from the same session model.
 */
interface TaskConversationProps {
  entries: DisplayEntry[];
  isLoading: boolean;
  error: string | null;
  messagesEndRef?: RefObject<HTMLDivElement | null>;
  onWikilinkClick?: (wikilink: string) => void;
  onFilePathClick?: (path: string) => void;
  /**
   * Optional externally-owned scroll container ref so a host (e.g. find) can
   * read the conversation viewport. Falls back to an internal ref.
   */
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null>;
  /** When true, render the whole conversation so search can reach every entry. */
  searchActive?: boolean;
  /** Stable key used to restore scroll position across session switches. */
  scrollCacheKey?: string;
  /** True while the active run is streaming content into the conversation. */
  isStreaming?: boolean;
  /** Increment to force auto-scroll back to the bottom, e.g. on user submit. */
  scrollToBottomSignal?: number;
  hasMoreHistory?: boolean;
  isLoadingMoreHistory?: boolean;
  onLoadMoreHistory?: () => Promise<void> | void;
}

export const TaskConversation = memo(function TaskConversation({
  entries,
  isLoading,
  error,
  messagesEndRef,
  onWikilinkClick,
  onFilePathClick,
  scrollContainerRef: externalScrollContainerRef,
  searchActive,
  scrollCacheKey = "session",
  isStreaming = false,
  scrollToBottomSignal = 0,
  hasMoreHistory = false,
  isLoadingMoreHistory = false,
  onLoadMoreHistory,
}: TaskConversationProps) {
  const internalScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef =
    externalScrollContainerRef ?? internalScrollContainerRef;
  const contentWrapperRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const isAutoScrollingRef = useRef(false);
  const isInitializingScrollRef = useRef(false);
  const scrollInitializedRef = useRef(false);
  const prevScrollTopRef = useRef(0);
  const observedScrollHeightRef = useRef(0);
  const resizeRafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      isAutoScrollingRef.current = false;
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, []);

  const saveScrollPosition = useCallback(() => {
    if (!scrollInitializedRef.current) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const wasAtBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD;
    conversationScrollPositionCache.set(scrollCacheKey, {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      wasAtBottom,
    });
  }, [scrollCacheKey, scrollContainerRef]);

  useEffect(() => {
    return () => {
      saveScrollPosition();
    };
  }, [saveScrollPosition]);

  const isAtBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return true;
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <=
      SCROLL_BOTTOM_THRESHOLD
    );
  }, [scrollContainerRef]);

  const jumpToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    isAutoScrollingRef.current = true;
    shouldAutoScrollRef.current = true;
    container.scrollTop = container.scrollHeight;
    prevScrollTopRef.current = container.scrollTop;
    observedScrollHeightRef.current = container.scrollHeight;

    requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    scrollInitializedRef.current = false;
    isInitializingScrollRef.current = true;

    const savedPosition =
      conversationScrollPositionCache.get(scrollCacheKey) ?? null;

    if (savedPosition && !savedPosition.wasAtBottom) {
      const savedOffset = savedPosition.scrollHeight - savedPosition.scrollTop;
      container.scrollTop = Math.max(0, container.scrollHeight - savedOffset);
      shouldAutoScrollRef.current = false;
    } else {
      container.scrollTop = container.scrollHeight;
      shouldAutoScrollRef.current = true;
    }

    prevScrollTopRef.current = container.scrollTop;
    observedScrollHeightRef.current = container.scrollHeight;
    scrollInitializedRef.current = true;
    isInitializingScrollRef.current = false;

    const contentWrapper = contentWrapperRef.current;
    if (!contentWrapper || typeof ResizeObserver === "undefined") return;

    let lastContentHeight = contentWrapper.getBoundingClientRect().height;
    let prevScrollHeight = container.scrollHeight;

    const resizeObserver = new ResizeObserver(() => {
      const nextContentHeight = contentWrapper.getBoundingClientRect().height;
      if (nextContentHeight === lastContentHeight) return;
      lastContentHeight = nextContentHeight;

      if (shouldAutoScrollRef.current) {
        if (resizeRafRef.current !== null) {
          cancelAnimationFrame(resizeRafRef.current);
        }
        resizeRafRef.current = requestAnimationFrame(() => {
          resizeRafRef.current = null;
          jumpToBottom();
          prevScrollHeight = container.scrollHeight;
        });
        return;
      }

      const nextScrollHeight = container.scrollHeight;
      if (nextScrollHeight !== prevScrollHeight && prevScrollHeight > 0) {
        const delta = nextScrollHeight - prevScrollHeight;
        container.scrollTop += delta;
        prevScrollTopRef.current = container.scrollTop;
      }
      prevScrollHeight = container.scrollHeight;
      observedScrollHeightRef.current = container.scrollHeight;
    });

    resizeObserver.observe(contentWrapper);

    return () => {
      resizeObserver.disconnect();
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
    };
  }, [jumpToBottom, scrollCacheKey, scrollContainerRef]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const currentScrollTop = container.scrollTop;
    const prevScrollTop = prevScrollTopRef.current;
    prevScrollTopRef.current = currentScrollTop;

    if (isInitializingScrollRef.current) return;

    if (currentScrollTop < prevScrollTop) {
      shouldAutoScrollRef.current = false;
      return;
    }

    if (isAutoScrollingRef.current) return;

    shouldAutoScrollRef.current = isAtBottom();
  }, [isAtBottom, scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll, scrollContainerRef]);

  useEffect(() => {
    if (!scrollInitializedRef.current) return;
    if (!isStreaming) return;
    if (!shouldAutoScrollRef.current) return;

    requestAnimationFrame(() => {
      jumpToBottom();
    });
  }, [entries, isStreaming, jumpToBottom]);

  useEffect(() => {
    if (scrollToBottomSignal <= 0) return;
    jumpToBottom();
  }, [jumpToBottom, scrollToBottomSignal]);

  const activateSelectScope = useCallback(() => {
    activateSessionSelectScope(scrollContainerRef.current);
  }, [scrollContainerRef]);

  useEffect(() => {
    const scope = scrollContainerRef.current;
    activateSessionSelectScope(scope);

    const handleKeyDown = (event: KeyboardEvent) => {
      const currentScope = scrollContainerRef.current;
      if (!currentScope || event.defaultPrevented) return;
      if (!isSelectAllShortcut(event)) return;
      if (shouldUseNativeSelectAll(event.target)) return;
      if (!shouldSelectSessionMessages(event, currentScope)) return;

      if (selectSessionMessages(currentScope)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handleCopy = (event: ClipboardEvent) => {
      const currentScope = scrollContainerRef.current;
      if (
        !currentScope ||
        currentScope.getAttribute(SESSION_SELECT_ACTIVE_ATTR) !== "true" ||
        !selectionTouchesScope(window.getSelection(), currentScope)
      ) {
        return;
      }

      const text = getSelectedSessionText(currentScope);
      if (!text || !event.clipboardData) return;

      event.preventDefault();
      event.clipboardData.setData("text/plain", text);
    };

    const handlePointerDown = () => {
      clearSessionSelectHighlight(scrollContainerRef.current);
    };

    const handleSelectionChange = () => {
      const currentScope = scrollContainerRef.current;
      if (
        !currentScope ||
        currentScope.getAttribute(SESSION_SELECT_ACTIVE_ATTR) !== "true"
      ) {
        return;
      }

      if (!selectionTouchesScope(window.getSelection(), currentScope)) {
        clearSessionSelectHighlight(currentScope);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("copy", handleCopy);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("selectionchange", handleSelectionChange);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("copy", handleCopy);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("selectionchange", handleSelectionChange);
      clearSessionSelectState(scrollContainerRef.current);
    };
  }, [scrollContainerRef]);

  const conversationContent =
    error && entries.length === 0 ? (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    ) : isLoading && entries.length === 0 ? (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    ) : (
      <ConversationEntries
        entries={entries}
        endRef={messagesEndRef}
        onWikilinkClick={onWikilinkClick}
        onFilePathClick={onFilePathClick}
        scrollContainerRef={scrollContainerRef}
        searchActive={searchActive}
        hasMoreHistory={hasMoreHistory}
        isLoadingMoreHistory={isLoadingMoreHistory}
        onLoadMoreHistory={onLoadMoreHistory}
        onScrollAnchorWillAdjust={() => {
          shouldAutoScrollRef.current = false;
        }}
        onScrollAnchorAdjusted={() => {
          prevScrollTopRef.current = scrollContainerRef.current?.scrollTop ?? 0;
          observedScrollHeightRef.current =
            scrollContainerRef.current?.scrollHeight ?? 0;
        }}
      />
    );

  return (
    <div
      ref={scrollContainerRef}
      {...{ [SESSION_SELECT_SCOPE_ATTR]: "true" }}
      className="show-scrollbar flex-1 overflow-y-auto px-6 py-5"
      style={{ contain: "strict" }}
      onFocusCapture={activateSelectScope}
      onPointerDownCapture={activateSelectScope}
    >
      <div ref={contentWrapperRef} className="min-h-full">
        {conversationContent}
      </div>
    </div>
  );
});
