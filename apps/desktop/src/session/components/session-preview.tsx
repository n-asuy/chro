import { AgentLogo } from "@/components/agent-logo";
import { useLanguage } from "@/i18n";
import { formatRelativeTime } from "@/session/lib/relative-time";
import { taskApi } from "@/tasks/task-api";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { UserMessageContent } from "../conversation-view";
import type { StoredTask } from "../types";
import { CollapsibleMessage } from "./collapsible-message";
import { Markdown } from "./markdown";

/** Delay before a sustained hover first opens the preview. Once open, moving to
 * another row slides immediately with no delay. */
const OPEN_DELAY_MS = 320;
/** Grace period after leaving so the pointer can cross the gap into the panel
 * (or onto an adjacent row) without the preview closing under it. */
const CLOSE_DELAY_MS = 220;
/** Position-transition duration — the slide between rows. */
const SLIDE_MS = 180;
/** Cap the preview length so an enormous reply doesn't render in full; the
 * panel scrolls within its height limit for anything longer. */
const PREVIEW_MAX_CHARS = 4000;
const PANEL_WIDTH = 460;
/** Fixed height ceiling — the panel scrolls internally past this. */
const PANEL_MAX_HEIGHT = 460;
const GAP = 8;
const VIEWPORT_MARGIN = 12;

const truncate = (text: string): string =>
  text.length > PREVIEW_MAX_CHARS
    ? `${text.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…`
    : text;

/** Pull the first question text out of a pending AskUserQuestion approval.
 * Returns null for other tool approvals; the preview only surfaces questions
 * the user can answer, not permission prompts. */
const extractPendingQuestion = (
  approval: { tool_name: string; tool_input: unknown } | null | undefined,
): string | null => {
  if (!approval || approval.tool_name !== "AskUserQuestion") return null;
  const input = approval.tool_input as {
    questions?: Array<{ question?: unknown }>;
  } | null;
  const entry = input?.questions?.find(
    (item) => typeof item?.question === "string" && item.question.trim(),
  );
  return entry ? (entry.question as string).trim() : null;
};

interface PreviewTarget {
  /** Snapshot of the hovered task, taken at hover time. Everything the header
   * needs (title, agent, provenance, awaiting flag) is already on the row's
   * task record, so the panel grounds itself without any extra fetch. */
  task: StoredTask;
  rect: DOMRect;
}

interface PanelPosition {
  top: number;
  left: number;
  maxHeight: number;
}

/**
 * Place the panel to the right of the row, flipping to the left edge when it
 * would overflow the viewport, and clamp it vertically. Coordinates are in
 * viewport space (the panel is `position: fixed`).
 */
function computePosition(rect: DOMRect): PanelPosition {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = rect.right + GAP;
  if (left + PANEL_WIDTH + VIEWPORT_MARGIN > vw) {
    left = rect.left - GAP - PANEL_WIDTH;
  }
  left = Math.max(VIEWPORT_MARGIN, left);

  const maxHeight = Math.min(PANEL_MAX_HEIGHT, vh - VIEWPORT_MARGIN * 2);
  let top = rect.top;
  if (top + maxHeight > vh - VIEWPORT_MARGIN) {
    top = vh - VIEWPORT_MARGIN - maxHeight;
  }
  top = Math.max(VIEWPORT_MARGIN, top);

  return { top, left, maxHeight };
}

interface PreviewController {
  notifyEnter: (task: StoredTask, el: HTMLElement) => void;
  notifyLeave: () => void;
  notifyDismiss: () => void;
}

const PreviewContext = createContext<PreviewController | null>(null);

/**
 * Hover trigger for a single session row. Attach `setAnchor` to the row element
 * and spread `hoverProps`; the shared panel (rendered once by
 * {@link SessionPreviewProvider}) handles display and slides between rows.
 */
export function useSessionPreviewTrigger(task: StoredTask): {
  setAnchor: (el: HTMLElement | null) => void;
  hoverProps: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
    onPointerDown: () => void;
  };
} {
  const controller = useContext(PreviewContext);
  const elRef = useRef<HTMLElement | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;

  const setAnchor = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const onPointerEnter = useCallback(() => {
    if (elRef.current) controller?.notifyEnter(taskRef.current, elRef.current);
  }, [controller]);
  const onPointerLeave = useCallback(() => {
    controller?.notifyLeave();
  }, [controller]);
  const onPointerDown = useCallback(() => {
    controller?.notifyDismiss();
  }, [controller]);

  return {
    setAnchor,
    hoverProps: { onPointerEnter, onPointerLeave, onPointerDown },
  };
}

interface PreviewView {
  open: boolean;
  target: PreviewTarget | null;
}

/**
 * Provides a single hover-preview panel shared by every descendant session row.
 * Hovering a row opens the panel; moving to another row while it is open slides
 * the same panel to the new row instead of closing and reopening. The reply is
 * fetched lazily for whichever row is targeted and the panel is portaled to
 * `document.body` with a high z-index so it escapes sidebar clipping.
 */
export function SessionPreviewProvider({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [view, setView] = useState<PreviewView>({ open: false, target: null });
  const openRef = useRef(false);
  const targetRef = useRef<PreviewTarget | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const commit = useCallback((open: boolean, target: PreviewTarget | null) => {
    openRef.current = open;
    targetRef.current = target;
    setView({ open, target });
  }, []);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    if (closeTimerRef.current !== null) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      commit(false, targetRef.current);
    }, CLOSE_DELAY_MS);
  }, [clearOpenTimer, commit]);

  const notifyEnter = useCallback(
    (task: StoredTask, el: HTMLElement) => {
      clearCloseTimer();
      const target: PreviewTarget = {
        task,
        rect: el.getBoundingClientRect(),
      };
      if (openRef.current) {
        // Already showing: slide the same panel to the new row.
        commit(true, target);
        return;
      }
      clearOpenTimer();
      openTimerRef.current = window.setTimeout(() => {
        openTimerRef.current = null;
        commit(true, target);
      }, OPEN_DELAY_MS);
    },
    [clearCloseTimer, clearOpenTimer, commit],
  );

  const notifyLeave = useCallback(() => {
    clearOpenTimer();
    scheduleClose();
  }, [clearOpenTimer, scheduleClose]);

  const notifyDismiss = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    commit(false, targetRef.current);
  }, [clearOpenTimer, clearCloseTimer, commit]);

  const controller = useMemo<PreviewController>(
    () => ({ notifyEnter, notifyLeave, notifyDismiss }),
    [notifyEnter, notifyLeave, notifyDismiss],
  );

  // Dismiss when the page behind the panel scrolls or the window resizes.
  // Scrolling *inside* the panel must not dismiss it.
  useEffect(() => {
    if (!view.open) return;
    const onScroll = (event: Event) => {
      const target = event.target;
      if (
        panelRef.current &&
        target instanceof Node &&
        panelRef.current.contains(target)
      ) {
        return;
      }
      notifyDismiss();
    };
    const onResize = () => notifyDismiss();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [view.open, notifyDismiss]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    [clearOpenTimer, clearCloseTimer],
  );

  const targetTask = view.target?.task ?? null;
  const query = useQuery({
    queryKey: [
      "task-last-message",
      targetTask?.id,
      targetTask?.updated_at,
    ],
    queryFn: () => taskApi.lastExchange(targetTask?.id ?? ""),
    enabled: view.open && Boolean(targetTask),
    staleTime: 30_000,
    // Keep the prior exchange visible while sliding to a new row so the panel
    // updates smoothly instead of flashing a loading state on every move.
    placeholderData: keepPreviousData,
  });

  // The question the agent is blocked on, fetched only while the hovered task
  // is actually waiting on one. Lets the user decide whether to answer without
  // opening the session.
  const awaitingInput = Boolean(targetTask?.awaiting_input);
  const pendingQuery = useQuery({
    queryKey: ["task-pending-question", targetTask?.id],
    queryFn: () => taskApi.pendingQuestion(targetTask?.id ?? ""),
    enabled: view.open && awaitingInput,
    staleTime: 10_000,
  });
  const pendingQuestion = awaitingInput
    ? extractPendingQuestion(pendingQuery.data)
    : null;

  const exchange = query.data;
  const hasContent = Boolean(exchange?.user || exchange?.assistant);
  const showLoading = query.isLoading || (query.isFetching && !hasContent);
  const position = view.target ? computePosition(view.target.rect) : null;
  const provenance = targetTask?.forked_from_title
    ? t("forkedFrom", { title: targetTask.forked_from_title })
    : targetTask?.delegated_from_title
      ? t("delegatedFrom", { title: targetTask.delegated_from_title })
      : null;

  return (
    <PreviewContext.Provider value={controller}>
      {children}
      {view.open && position
        ? createPortal(
            <div
              ref={panelRef}
              role="tooltip"
              onPointerEnter={clearCloseTimer}
              onPointerLeave={scheduleClose}
              style={{
                position: "fixed",
                top: position.top,
                left: position.left,
                width: PANEL_WIDTH,
                maxHeight: position.maxHeight,
                transition: `top ${SLIDE_MS}ms ease, left ${SLIDE_MS}ms ease`,
              }}
              className="z-[200] flex flex-col overflow-hidden rounded-xl border border-border bg-popover px-3 py-2.5 text-[12px] leading-relaxed text-popover-foreground shadow-lg"
            >
              {/* Grounding header, rendered from the hover-time task snapshot
                  with no fetch: which session this is, run by which agent, how
                  recently. Session state (spinner/pause/failure) is NOT
                  repeated here; the row right next to the panel already shows
                  it. */}
              <div className="flex shrink-0 items-center gap-2">
                <AgentLogo
                  agent={targetTask?.last_executor}
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
                  {targetTask?.title}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {targetTask ? formatRelativeTime(targetTask.updated_at) : ""}
                </span>
              </div>
              {provenance ? (
                <div className="mt-0.5 shrink-0 truncate text-[11px] text-muted-foreground">
                  {provenance}
                </div>
              ) : null}
              <div
                // Reset expand/scroll state when the panel slides to another
                // session.
                key={targetTask?.id}
                className="mt-2 flex min-h-0 flex-col gap-2"
              >
                {query.isError ? (
                  <span className="text-muted-foreground">
                    {t("sessionPreviewError")}
                  </span>
                ) : showLoading ? (
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      aria-hidden="true"
                    />
                    {t("sessionPreviewLoading")}
                  </span>
                ) : hasContent || pendingQuestion ? (
                  <>
                    {exchange?.user ? (
                      <div className="shrink-0 rounded-md bg-custom-sidebar-background-80 px-3 py-2">
                        <CollapsibleMessage fadeClassName="from-custom-sidebar-background-80">
                          <UserMessageContent content={exchange.user} />
                        </CollapsibleMessage>
                      </div>
                    ) : null}
                    {pendingQuestion ? (
                      <div className="shrink-0 rounded-md border border-border px-3 py-2">
                        <div className="text-[11px] font-medium text-muted-foreground">
                          {t("sessionAwaitingInput")}
                        </div>
                        <div className="mt-1 text-foreground">
                          {pendingQuestion}
                        </div>
                      </div>
                    ) : null}
                    {exchange?.assistant ? (
                      <div className="min-h-0 overflow-y-auto overscroll-contain px-1">
                        <Markdown headings="flat">
                          {truncate(exchange.assistant)}
                        </Markdown>
                        {/* Sticky bottom fade signalling clipped content; the
                            reply scrolls underneath it and the trailing
                            padding keeps the last line readable at scroll
                            end. */}
                        <div className="pointer-events-none sticky bottom-0 -mt-10 h-10 bg-gradient-to-b from-transparent to-popover" />
                        <div className="h-4" />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    {t("sessionPreviewEmpty")}
                  </span>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </PreviewContext.Provider>
  );
}
