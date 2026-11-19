import "../edge-toolbar.css";
import { useLanguage } from "@/i18n";
import { useSessionReadSync } from "@/session/hooks/use-session-read-state";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  PANEL_CONTENT_WAIT_MS,
  type PanelPresence,
  closedPresence,
  keyboardSummon,
  nextPresence,
  panelOnScreen,
  panelTop,
  parseCssTime,
  toolbarSurface,
} from "../domain/edge-motion";
import { isTalking, optionAction } from "../domain/talk";
import { useEdgeSessions } from "../hooks/use-edge-sessions";
import { useEdgeVoice } from "../hooks/use-edge-voice";
import {
  type EdgeHitRegion,
  type EdgePointer,
  focusEdgeWindow,
  onEdgePointer,
  onEdgePresence,
  onOptionGesture,
  openAppView,
  setEdgeHitRegions,
} from "../lib/edge-window-client";
import {
  type EdgePanel,
  useEdgeToolbarStore,
} from "../state/edge-toolbar-store";
import { MORE_ITEM_COUNT, type MoreItem } from "./edge-more";
import { PanelReadyContext } from "./edge-panel-ready";
import { EdgeSessionList, EdgeSessionPreview } from "./edge-session-list";
import { EdgeSessionPanel } from "./edge-session-panel";
import { EdgeTalkPill } from "./edge-talk-pill";
import {
  DOT_GROWN_EVENT,
  DOT_GROW_ANIMATION,
  EdgeToolbar,
} from "./edge-toolbar";
import { EdgeUsagePanel } from "./edge-usage-panel";
import { UnreadPager } from "./unread-pager";

/** One item of the open "…" capsule and the capsule's padding (the mock's .more). */
const MORE_ITEM_HEIGHT = 32;
const MORE_PADDING = 8;

/** After a panel closes, the toolbar tucks back in this much later (the mock's collapseSoon). */
const COLLAPSE_DELAY_MS = 600;

/** Used when the stylesheet's panel durations cannot be read. */
const PANEL_EXIT_FALLBACK_MS = { standard: 320, quick: 160 } as const;

/** The mock's two panel timings: standard, and quick for panels opened by pointing. */
type PanelTiming = keyof typeof PANEL_EXIT_FALLBACK_MS;

const EXIT_VARIABLE: Record<PanelTiming, string> = {
  standard: "--edge-panel-move",
  quick: "--edge-panel-quick-move",
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA"
  );
}

/**
 * A panel frame's state: on as soon as its panel opens, and kept mounted,
 * off, for the length of its exit transition after it closes.
 */
function usePanelPresence(
  panel: EdgePanel,
  timing: PanelTiming,
  rootRef: RefObject<HTMLDivElement | null>,
): PanelPresence {
  const [presence, setPresence] = useState<PanelPresence>(closedPresence);
  useLayoutEffect(() => {
    setPresence((prev) => nextPresence(prev, panel));
  }, [panel]);
  useEffect(() => {
    if (presence.on || presence.shown === null) return;
    const root = rootRef.current;
    const exitMs = root
      ? parseCssTime(
          getComputedStyle(root).getPropertyValue(EXIT_VARIABLE[timing]),
          PANEL_EXIT_FALLBACK_MS[timing],
        )
      : PANEL_EXIT_FALLBACK_MS[timing];
    const timer = window.setTimeout(() => {
      setPresence((prev) => (prev.on ? prev : closedPresence));
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [presence, timing, rootRef]);
  return presence;
}

/**
 * A panel's animated frame. It mounts off and is switched on only after its
 * off style has been computed and its content has laid out (see
 * `panelOnScreen`), so opening plays the transition from the off state with
 * the content in its first visible frame.
 */
function PanelFrame({
  on,
  timing,
  children,
}: {
  on: boolean;
  timing: PanelTiming;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  const [waitedOut, setWaitedOut] = useState(false);
  useLayoutEffect(() => {
    // Reading layout commits the off style before the switch below.
    void ref.current?.offsetHeight;
    setMounted(true);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setWaitedOut(true),
      PANEL_CONTENT_WAIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);
  const markReady = useCallback(() => setContentReady(true), []);
  const shown = panelOnScreen({ open: on, mounted, contentReady, waitedOut });
  return (
    <PanelReadyContext.Provider value={markReady}>
      <div
        ref={ref}
        className="edge-panel"
        data-timing={timing}
        data-on={shown ? "" : undefined}
      >
        {children}
      </div>
    </PanelReadyContext.Provider>
  );
}

interface Slots {
  card: RefObject<HTMLDivElement | null>;
  list: RefObject<HTMLDivElement | null>;
  preview: RefObject<HTMLDivElement | null>;
  usage: RefObject<HTMLDivElement | null>;
}

/**
 * Place the toolbar so its capsule's centre sits at the frame's vertical
 * centre (the tab and the capsule share it, so dots stay put when it
 * unfolds); the card level with the toolbar's top and the list and its
 * preview level with the capsule's top, as the mock anchors them, each kept
 * inside the frame. Layout offsets, not client rects, so running transitions
 * never move the anchors.
 */
function useEdgeLayout(
  rootRef: RefObject<HTMLDivElement | null>,
  toolbarRef: RefObject<HTMLDivElement | null>,
  capsuleRef: RefObject<HTMLDivElement | null>,
  slots: Slots,
) {
  const place = useCallback(() => {
    const root = rootRef.current;
    const toolbar = toolbarRef.current;
    const capsule = capsuleRef.current;
    if (!root || !toolbar || !capsule) return;
    // Hold the anchor while a dot grows in, as the mock does.
    const growing = capsule
      .getAnimations({ subtree: true })
      .some((a) => a.id === DOT_GROW_ANIMATION && a.playState === "running");
    if (growing) return;
    const center = capsule.offsetTop + capsule.offsetHeight / 2;
    toolbar.style.setProperty("--edge-capsule-center", `${center}px`);
    const toolbarTop = root.clientHeight / 2 - center;
    const capsuleTop = toolbarTop + capsule.offsetTop;
    const placeSlot = (slot: HTMLDivElement | null, anchor: number) => {
      if (!slot) return;
      slot.style.top = `${panelTop({ anchor, height: slot.offsetHeight, frameHeight: root.clientHeight })}px`;
    };
    placeSlot(slots.card.current, toolbarTop);
    placeSlot(slots.list.current, capsuleTop);
    placeSlot(slots.preview.current, capsuleTop);
    // The talk pill is centred on the microphone, as the mock's is.
    const mic = toolbar.querySelector<HTMLElement>("[data-edge-mic]");
    const tools = mic?.offsetParent;
    if (mic && tools instanceof HTMLElement) {
      const micCenter =
        toolbarTop + tools.offsetTop + mic.offsetTop + mic.offsetHeight / 2;
      root.style.setProperty("--edge-mic-center", `${micCenter}px`);
    }
    // Usage hangs from the bottom of the open "…" capsule, as the mock's does.
    const more = toolbar.querySelector<HTMLElement>(".edge-more");
    const usage = slots.usage.current;
    if (more && usage) {
      const openBottom =
        toolbarTop +
        more.offsetTop +
        MORE_ITEM_COUNT * MORE_ITEM_HEIGHT +
        MORE_PADDING;
      placeSlot(usage, openBottom - usage.offsetHeight);
    }
  }, [rootRef, toolbarRef, capsuleRef, slots]);

  // After every render, and whenever the capsule or a panel changes size
  // without one (fonts loading, a rule that sets the tab's height).
  useLayoutEffect(place);
  useEffect(() => {
    const observer = new ResizeObserver(place);
    for (const ref of [
      capsuleRef,
      slots.card,
      slots.list,
      slots.preview,
      slots.usage,
      rootRef,
    ]) {
      if (ref.current) observer.observe(ref.current);
    }
    const root = rootRef.current;
    root?.addEventListener(DOT_GROWN_EVENT, place);
    return () => {
      observer.disconnect();
      root?.removeEventListener(DOT_GROWN_EVENT, place);
    };
  });
}

const intersect = (a: DOMRect, b: DOMRect) => {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
};

/**
 * Report the surfaces that take the pointer (`[data-edge-hit]`) and the
 * named regions to follow the pointer over (`[data-edge-hover]`) to the
 * shell, which lets clicks through everywhere else. In document order, so a
 * named region comes after the surface containing it, and clipped to that
 * surface (a list row scrolled out of view reports nothing). Re-measured
 * after each render, when a surface resizes or scrolls, and when a transition
 * ends (the tab narrows over a transition, so its final box is known only then).
 */
function useHitRegions(
  rootRef: RefObject<HTMLDivElement | null>,
  /** Stepped aside: nothing takes the pointer. */
  hidden: boolean,
) {
  const last = useRef("");
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const report = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const regions: EdgeHitRegion[] = [];
    const frameRight = root.clientWidth;
    const nodes = hiddenRef.current
      ? []
      : root.querySelectorAll<HTMLElement>(
          "[data-edge-hit], [data-edge-hover]",
        );
    for (const node of nodes) {
      const own = node.getBoundingClientRect();
      const surface =
        node.dataset.edgeHit !== undefined
          ? null
          : node.parentElement?.closest<HTMLElement>("[data-edge-hit]");
      if (node.dataset.edgeHit === undefined && !surface) continue;
      const box = surface
        ? intersect(own, surface.getBoundingClientRect())
        : own;
      if (!box || box.right - box.left <= 0 || box.bottom - box.top <= 0)
        continue;
      // `to-edge` surfaces own the strip out to the screen edge too.
      const right = node.dataset.edgeHit === "to-edge" ? frameRight : box.right;
      const left = Math.floor(box.left);
      regions.push({
        x: left,
        y: Math.floor(box.top),
        width: Math.ceil(right - left),
        height: Math.ceil(box.bottom - Math.floor(box.top)),
        ...(node.dataset.edgeHover ? { id: node.dataset.edgeHover } : {}),
      });
    }
    const key = JSON.stringify(regions);
    if (key === last.current) return;
    last.current = key;
    setEdgeHitRegions(regions);
  }, [rootRef]);

  useLayoutEffect(report);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(report);
    const observe = () => {
      observer.disconnect();
      for (const node of root.querySelectorAll("[data-edge-hit]")) {
        observer.observe(node);
      }
    };
    observe();
    const mutations = new MutationObserver(() => {
      observe();
      report();
    });
    mutations.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-edge-hit", "data-edge-hover"],
      childList: true,
    });
    root.addEventListener("transitionend", report);
    root.addEventListener("scroll", report, true);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      root.removeEventListener("transitionend", report);
      root.removeEventListener("scroll", report, true);
      window.removeEventListener("resize", report);
    };
  }, [rootRef, report]);
}

const isOpenCard = (panel: EdgePanel): EdgePanel =>
  panel?.kind === "unread" || panel?.kind === "session" ? panel : null;

/**
 * The edge toolbar's window content: the entry to sessions from anywhere on
 * the screen, with the mock's triggers (Dots design). Collapsed it is a tab
 * of session dots; pointing at it shows a hint, clicking it brings the
 * toolbar out with Unread. On the toolbar, pointing at the capsule opens the
 * session list, pointing at a row previews that session beside it, clicking
 * a row or a dot opens the session's compact panel. Closing a panel tucks the
 * toolbar back in 600 ms later. Everything beyond a quick reply opens in the
 * session window.
 *
 * The window is a fixed transparent frame (see the shell's `edge.rs`): every
 * change of shape is a CSS transition inside it, copied from the mock.
 */
export function EdgeToolbarApp() {
  useSessionReadSync();
  const { t } = useLanguage();
  const { sessions, dots, allDots, tasksById, existing } = useEdgeSessions();
  const expanded = useEdgeToolbarStore((s) => s.expanded);
  const panel = useEdgeToolbarStore((s) => s.panel);
  const preview = useEdgeToolbarStore((s) => s.preview);
  const hint = useEdgeToolbarStore((s) => s.hint);
  const collapse = useEdgeToolbarStore((s) => s.collapse);
  const summon = useEdgeToolbarStore((s) => s.summon);
  const openList = useEdgeToolbarStore((s) => s.openList);
  const openUnread = useEdgeToolbarStore((s) => s.openUnread);
  const openSession = useEdgeToolbarStore((s) => s.openSession);
  const closePanel = useEdgeToolbarStore((s) => s.closePanel);
  const stepUnread = useEdgeToolbarStore((s) => s.stepUnread);
  const toggleHelp = useEdgeToolbarStore((s) => s.toggleHelp);
  const unread = useEdgeToolbarStore((s) => s.unread);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const usageRef = useRef<HTMLDivElement | null>(null);
  const slots = useMemo<Slots>(
    () => ({
      card: cardRef,
      list: listRef,
      preview: previewRef,
      usage: usageRef,
    }),
    [],
  );
  const moreOpen = useEdgeToolbarStore((s) => s.moreOpen);
  const setMoreOpen = useEdgeToolbarStore((s) => s.setMoreOpen);
  const toggleUsage = useEdgeToolbarStore((s) => s.toggleUsage);

  const surface = toolbarSurface(expanded, panel);
  const listPanel: EdgePanel = panel?.kind === "list" ? panel : null;
  const previewPanel: EdgePanel = useMemo(
    () => (listPanel && preview ? { kind: "session", taskId: preview } : null),
    [listPanel, preview],
  );
  const card = usePanelPresence(isOpenCard(panel), "standard", rootRef);
  const list = usePanelPresence(listPanel, "quick", rootRef);
  const previewed = usePanelPresence(previewPanel, "quick", rootRef);
  const usagePanel: EdgePanel = panel?.kind === "usage" ? panel : null;
  const usage = usePanelPresence(usagePanel, "quick", rootRef);
  useEdgeLayout(rootRef, toolbarRef, capsuleRef, slots);
  const hidden = useEdgeToolbarStore((s) => s.hidden);
  useHitRegions(rootRef, hidden);

  const collapseTimer = useRef<number | null>(null);
  const cancelCollapse = useCallback(() => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }, []);
  const scheduleCollapse = useCallback(() => {
    cancelCollapse();
    collapseTimer.current = window.setTimeout(collapse, COLLAPSE_DELAY_MS);
  }, [cancelCollapse, collapse]);
  useEffect(() => cancelCollapse, [cancelCollapse]);

  // The mock's pointer triggers: the tab shows its hint, the capsule opens
  // the session list (only when nothing else is open), a row is previewed.
  const onPointer = useCallback(
    ({ id }: EdgePointer) => {
      const store = useEdgeToolbarStore.getState();
      store.setHint(id === "tab");
      // "…" opens while pointed at (the mock's hoverOpens) and folds when
      // left, unless its usage panel is open.
      store.setMoreOpen(id === "more");
      if (id === "capsule" && !store.panel && store.expanded) {
        cancelCollapse();
        openList();
      }
      if (id?.startsWith("row:")) store.previewSession(id.slice(4));
    },
    [cancelCollapse, openList],
  );
  useEffect(() => onEdgePointer(onPointer), [onPointer]);

  // An open panel takes the keyboard, so J/K and Esc reach it.
  const panelOpen = panel !== null;
  useEffect(() => {
    if (panelOpen) focusEdgeWindow();
  }, [panelOpen]);

  // Every way of closing a panel (button, Esc, toolbar toggle) ends here.
  const handleClosePanel = useCallback(() => {
    closePanel();
    scheduleCollapse();
  }, [closePanel, scheduleCollapse]);

  const voice = useEdgeVoice({
    tasksById,
    newChatTitle: t("newChat"),
    cancelCollapse,
    scheduleCollapse,
  });

  // The Option gestures anywhere (the shell watches the keyboard): twice
  // opens Unread when something needs the user, else the session list, and
  // again closes it; held, it is press to talk; tapped while listening, send.
  const hasUnread = sessions.length > 0;
  const { beginTalking, finishTalking, cancelTalking } = voice;

  // chro's own window came to the front or left it: the toolbar steps
  // aside (closing what is open, stopping any talking without a send) and
  // comes back as the collapsed tab.
  useEffect(
    () =>
      onEdgePresence((nowHidden) => {
        if (nowHidden) {
          cancelTalking();
          cancelCollapse();
        }
        useEdgeToolbarStore.getState().setHidden(nowHidden);
      }),
    [cancelTalking, cancelCollapse],
  );

  useEffect(
    () =>
      onOptionGesture((gesture) => {
        const store = useEdgeToolbarStore.getState();
        const action = optionAction(gesture, store.talk);
        if (action === "startTalk") void beginTalking();
        if (action === "endTalk") finishTalking();
        if (action !== "summon") return;
        const summon = keyboardSummon(store.panel, hasUnread);
        if (summon === "close") {
          handleClosePanel();
          return;
        }
        cancelCollapse();
        if (summon === "unread") {
          store.openUnread();
        } else {
          store.closePanel();
          store.openList();
        }
      }),
    [hasUnread, cancelCollapse, handleClosePanel, beginTalking, finishTalking],
  );

  // "…" items: Settings and Feedback live in the main window; Usage is a
  // panel of its own beside the open capsule.
  const handleMoreItem = useCallback(
    (item: MoreItem) => {
      if (item !== "usage") {
        openAppView(item);
        return;
      }
      if (useEdgeToolbarStore.getState().panel?.kind === "usage") {
        handleClosePanel();
        return;
      }
      cancelCollapse();
      toggleUsage();
    },
    [cancelCollapse, handleClosePanel, toggleUsage],
  );

  const handleSummon = useCallback(() => {
    cancelCollapse();
    summon();
  }, [cancelCollapse, summon]);

  // A click on the capsule (not on a dot): the list, or away from it.
  const handleToggleList = useCallback(() => {
    cancelCollapse();
    if (useEdgeToolbarStore.getState().panel?.kind === "list") {
      handleClosePanel();
      return;
    }
    closePanel();
    openList();
  }, [cancelCollapse, closePanel, openList, handleClosePanel]);

  const handleOpenSession = useCallback(
    (taskId: string) => {
      cancelCollapse();
      openSession(taskId);
    },
    [cancelCollapse, openSession],
  );

  // A session archived or deleted while its panel is open.
  const sessionPanelTask =
    panel?.kind === "session" ? tasksById.get(panel.taskId) ?? null : null;
  const missingSession = panel?.kind === "session" && !sessionPanelTask;
  useEffect(() => {
    if (missingSession && tasksById.size > 0) handleClosePanel();
  }, [missingSession, tasksById.size, handleClosePanel]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const { panel: open, help } = useEdgeToolbarStore.getState();
      // Esc while talking stops without sending.
      if (event.key === "Escape" && cancelTalking()) {
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        if (isEditable(event.target)) {
          (event.target as HTMLElement).blur();
          return;
        }
        if (open) {
          event.preventDefault();
          // Esc leaves the help first, then closes the panel.
          if (help && open.kind !== "list") toggleHelp();
          else handleClosePanel();
        }
        return;
      }
      if (isEditable(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (open && open.kind !== "list" && event.key === "?") {
        event.preventDefault();
        toggleHelp();
        return;
      }
      if (open?.kind !== "unread") return;
      const key = event.key.toLowerCase();
      if (key === "j") {
        event.preventDefault();
        stepUnread(-1);
      } else if (key === "k") {
        event.preventDefault();
        stepUnread(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleClosePanel, stepUnread, toggleHelp, cancelTalking]);

  // What each frame shows: its open panel, or the one closing.
  const cardShown = card.shown;
  const cardTask =
    cardShown?.kind === "session"
      ? tasksById.get(cardShown.taskId) ?? null
      : null;
  const previewShown = previewed.shown;
  const previewTask =
    previewShown?.kind === "session"
      ? tasksById.get(previewShown.taskId) ?? null
      : null;
  const previewDot = previewTask
    ? allDots.find((dot) => dot.task.id === previewTask.id)
    : undefined;

  return (
    <div
      ref={rootRef}
      data-edge-root
      data-presence={hidden ? "hidden" : "shown"}
      className="edge-root"
    >
      {cardShown ? (
        <div
          ref={cardRef}
          className="edge-panel-slot"
          data-slot="card"
          data-edge-hit={card.on ? "" : undefined}
        >
          <PanelFrame on={card.on} timing="standard">
            {cardShown.kind === "unread" ? (
              <UnreadPager
                sessions={sessions}
                tasksById={tasksById}
                existing={existing}
                onClose={handleClosePanel}
              />
            ) : cardTask ? (
              <EdgeSessionPanel
                key={cardTask.id}
                task={cardTask}
                onClose={handleClosePanel}
              />
            ) : null}
          </PanelFrame>
        </div>
      ) : null}
      {list.shown ? (
        <div
          ref={listRef}
          className="edge-panel-slot"
          data-slot="list"
          data-edge-hit={list.on ? "" : undefined}
        >
          <PanelFrame on={list.on} timing="quick">
            <EdgeSessionList
              dots={allDots}
              previewId={preview}
              onOpenSession={handleOpenSession}
            />
          </PanelFrame>
        </div>
      ) : null}
      {usage.shown ? (
        <div
          ref={usageRef}
          className="edge-panel-slot"
          data-slot="usage"
          data-edge-hit={usage.on ? "" : undefined}
        >
          <PanelFrame on={usage.on} timing="quick">
            <EdgeUsagePanel />
          </PanelFrame>
        </div>
      ) : null}
      {previewTask && previewDot ? (
        <div
          ref={previewRef}
          className="edge-panel-slot"
          data-slot="preview"
          data-edge-hit={previewed.on ? "" : undefined}
        >
          <PanelFrame on={previewed.on} timing="quick">
            <EdgeSessionPreview task={previewTask} status={previewDot.status} />
          </PanelFrame>
        </div>
      ) : null}
      <EdgeToolbar
        surface={surface}
        dots={dots}
        unread={sessions}
        panel={panel}
        pager={panel?.kind === "unread" ? unread : null}
        hint={hint}
        toolbarRef={toolbarRef}
        capsuleRef={capsuleRef}
        onSummon={handleSummon}
        onToggleList={handleToggleList}
        onOpenUnread={() =>
          panel?.kind === "unread" ? handleClosePanel() : openUnread()
        }
        onOpenSession={(taskId) =>
          panel?.kind === "session" && panel.taskId === taskId
            ? handleClosePanel()
            : handleOpenSession(taskId)
        }
        moreOpen={moreOpen}
        onOpenMore={() => setMoreOpen(true)}
        onMoreItem={handleMoreItem}
        recording={isTalking(voice.talk)}
        onMic={voice.toggleMic}
        onCapture={() => void voice.beginCapture()}
      />
      <EdgeTalkPill
        talk={voice.talk}
        targetTitle={voice.targetTitle}
        onOpenSettings={voice.openSettings}
      />
    </div>
  );
}
