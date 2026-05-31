import { Button } from "@chro/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, Loader2 } from "lucide-react";
import {
  type MutableRefObject,
  type RefObject,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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
  const pendingConversationAnchorAdjustRef = useRef(false);
  const observedScrollHeightRef = useRef(0);
  const resizeRafRef = useRef<number | null>(null);
  const scrollAnimationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      isAutoScrollingRef.current = false;
      if (resizeRafRef.current !== null) {
        cancelAnimationFrame(resizeRafRef.current);
        resizeRafRef.current = null;
      }
      if (scrollAnimationFrameRef.current !== null) {
        cancelAnimationFrame(scrollAnimationFrameRef.current);
        scrollAnimationFrameRef.current = null;
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

  const cancelAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = false;
    isAutoScrollingRef.current = false;
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    if (scrollAnimationFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
  }, []);

  const jumpToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    isAutoScrollingRef.current = true;
    container.scrollTop = container.scrollHeight;
    prevScrollTopRef.current = container.scrollTop;
    observedScrollHeightRef.current = container.scrollHeight;
    requestAnimationFrame(() => {
      isAutoScrollingRef.current = false;
    });
  }, [scrollContainerRef]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (scrollAnimationFrameRef.current !== null) {
      cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }

    isAutoScrollingRef.current = true;
    shouldAutoScrollRef.current = true;

    const start = container.scrollTop;
    const duration = 300;
    const startTime = performance.now();
    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = easeInOutCubic(progress);
      const end = container.scrollHeight - container.clientHeight;

      container.scrollTop = start + (end - start) * easedProgress;
      prevScrollTopRef.current = container.scrollTop;

      if (progress < 1) {
        scrollAnimationFrameRef.current = requestAnimationFrame(animateScroll);
        return;
      }

      container.scrollTop = container.scrollHeight;
      prevScrollTopRef.current = container.scrollTop;
      observedScrollHeightRef.current = container.scrollHeight;
      isAutoScrollingRef.current = false;
      scrollAnimationFrameRef.current = null;
    };

    scrollAnimationFrameRef.current = requestAnimationFrame(animateScroll);
  }, [scrollContainerRef]);

  const handleConversationAnchorWillAdjust = useCallback(() => {
    pendingConversationAnchorAdjustRef.current = true;
  }, []);

  const handleConversationAnchorAdjusted = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      observedScrollHeightRef.current = container.scrollHeight;
      prevScrollTopRef.current = container.scrollTop;
    }
    pendingConversationAnchorAdjustRef.current = false;
  }, [scrollContainerRef]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    scrollInitializedRef.current = false;
    isInitializingScrollRef.current = true;
    pendingConversationAnchorAdjustRef.current = false;

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
    let lastContentHeight = contentWrapper?.getBoundingClientRect().height ?? 0;

    const resizeObserver = new ResizeObserver(() => {
      const nextContentHeight =
        contentWrapper?.getBoundingClientRect().height ?? 0;
      if (nextContentHeight === lastContentHeight) return;
      lastContentHeight = nextContentHeight;

      if (pendingConversationAnchorAdjustRef.current) {
        observedScrollHeightRef.current = container.scrollHeight;
        return;
      }

      if (shouldAutoScrollRef.current) {
        if (resizeRafRef.current !== null) {
          cancelAnimationFrame(resizeRafRef.current);
        }
        resizeRafRef.current = requestAnimationFrame(() => {
          resizeRafRef.current = null;
          if (!shouldAutoScrollRef.current) {
            observedScrollHeightRef.current = container.scrollHeight;
            return;
          }
          jumpToBottom();
        });
        return;
      }

      observedScrollHeightRef.current = container.scrollHeight;
    });

    if (contentWrapper) {
      resizeObserver.observe(contentWrapper);
    }

    return () => {
      resizeObserver.disconnect();
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
      cancelAutoScroll();
      return;
    }

    if (isAutoScrollingRef.current) return;

    shouldAutoScrollRef.current = isAtBottom();
  }, [cancelAutoScroll, isAtBottom, scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [handleScroll, scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        cancelAutoScroll();
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [cancelAutoScroll, scrollContainerRef]);

  useEffect(() => {
    if (!scrollInitializedRef.current) return;
    if (!isStreaming) return;
    if (!shouldAutoScrollRef.current) return;

    const animationFrameId = requestAnimationFrame(() => {
      if (!shouldAutoScrollRef.current) return;
      jumpToBottom();
    });

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [entries, isStreaming, jumpToBottom, scrollCacheKey]);

  useEffect(() => {
    if (scrollToBottomSignal <= 0) return;
    scrollToBottom();
  }, [scrollToBottom, scrollToBottomSignal]);

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
        onScrollAnchorWillAdjust={handleConversationAnchorWillAdjust}
        onScrollAnchorAdjusted={handleConversationAnchorAdjusted}
      />
    );

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollContainerRef}
        {...{ [SESSION_SELECT_SCOPE_ATTR]: "true" }}
        className="show-scrollbar flex-1 overflow-y-auto px-6 py-5"
        style={{ contain: "strict", overflowAnchor: "none" }}
        onFocusCapture={activateSelectScope}
        onPointerDownCapture={activateSelectScope}
      >
        <div ref={contentWrapperRef} className="min-h-full">
          {conversationContent}
        </div>
      </div>
      <ScrollToBottomButton
        containerRef={scrollContainerRef}
        onScrollToBottom={scrollToBottom}
        scrollCacheKey={scrollCacheKey}
      />
    </div>
  );
});

const ScrollToBottomButton = memo(function ScrollToBottomButton({
  containerRef,
  onScrollToBottom,
  scrollCacheKey,
}: {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  onScrollToBottom: () => void;
  scrollCacheKey: string;
}) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    let lastAtBottom: boolean | null = null;

    const setVisibilityFromScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const atBottom =
          container.scrollHeight -
            container.scrollTop -
            container.clientHeight <=
          SCROLL_BOTTOM_THRESHOLD;
        if (lastAtBottom !== atBottom) {
          lastAtBottom = atBottom;
          setIsVisible(!atBottom);
        }
      });
    };

    const timeoutId = window.setTimeout(() => {
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <=
        SCROLL_BOTTOM_THRESHOLD;
      lastAtBottom = atBottom;
      setIsVisible(!atBottom);
    }, 50);

    container.addEventListener("scroll", setVisibilityFromScroll, {
      passive: true,
    });
    return () => {
      window.clearTimeout(timeoutId);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      container.removeEventListener("scroll", setVisibilityFromScroll);
    };
  }, [containerRef, scrollCacheKey]);

  return (
    <AnimatePresence>
      {isVisible && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="absolute bottom-3 right-4 z-20"
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={onScrollToBottom}
                  aria-label="Scroll to bottom"
                  className="h-9 w-9 rounded-full border-border bg-background shadow-md hover:bg-accent"
                >
                  <ArrowDown className="h-4 w-4 text-muted-foreground" />
                </Button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[11px]">
              Scroll to bottom
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </AnimatePresence>
  );
});
