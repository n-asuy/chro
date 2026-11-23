import "../edge-toolbar.css";
import { useLanguage } from "@/i18n";
import { useFeatureFlagStore } from "@/lib/feature-flags-store";
import { useSessionReadSync } from "@/session/hooks/use-session-read-state";
import {
  type CSSProperties,
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
  hitSpan,
  keepsPeekOpen,
  keyboardSummon,
  nextNeedsYou,
  nextPresence,
  panelOnScreen,
  panelTop,
  parseCssTime,
  peekAnchor,
  toolbarSurface,
} from "../domain/edge-motion";
import { isTalking, optionAction } from "../domain/talk";
import { EdgeVoiceActionsContext } from "../hooks/edge-voice-actions";
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
  openSessionInApp,
  setEdgeHitRegions,
  setEdgeSide,
} from "../lib/edge-window-client";
import {
  type EdgeSide,
  clampEdgeY,
  sideForDrop,
  useEdgePrefs,
} from "../state/edge-prefs";
import {
  type EdgePanel,
  type SettingsPage,
  useEdgeToolbarStore,
} from "../state/edge-toolbar-store";
import { MORE_ITEM_COUNT, type MoreItem } from "./edge-more";
import { PanelReadyContext } from "./edge-panel-ready";
import { EdgeSessionList, EdgeSessionPreview } from "./edge-session-list";
import { EdgeSessionPanel } from "./edge-session-panel";
import { EdgeSettingsMenu, EdgeSettingsPage } from "./edge-settings";
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
  peek: RefObject<HTMLDivElement | null>;
  usage: RefObject<HTMLDivElement | null>;
  settingsMenu: RefObject<HTMLDivElement | null>;
  settingsFly: RefObject<HTMLDivElement | null>;
}

/** The settings menu hangs from 8 item rows below the "…" capsule's top (the mock's). */
const SETTINGS_MENU_REACH = 8 * 32;

/** The settings flyout sits this much higher than the menu (the mock's). */
const SETTINGS_FLY_RISE = 40;

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
    // The toolbar sits at the frame's centre, moved by the dragged offset.
    const edgeY = Number.parseFloat(
      root.style.getPropertyValue("--edge-y") || "0",
    );
    const toolbarTop = root.clientHeight / 2 - center + edgeY;
    const capsuleTop = toolbarTop + capsule.offsetTop;
    const placeSlot = (slot: HTMLDivElement | null, anchor: number) => {
      if (!slot) return;
      slot.style.top = `${panelTop({ anchor, height: slot.offsetHeight, frameHeight: root.clientHeight })}px`;
    };
    placeSlot(slots.card.current, toolbarTop);
    placeSlot(slots.list.current, capsuleTop);
    placeSlot(slots.preview.current, capsuleTop);
    // A tile's preview sits level with its tile. Once placed, a move to
    // another tile slides it there (the transition is armed only after the
    // first placement, so the card does not fly in from the frame's top).
    const peek = slots.peek.current;
    const peekTile = peek?.dataset.peek
      ? capsule.querySelector<HTMLElement>(
          `[data-edge-dot="${CSS.escape(peek.dataset.peek)}"]`,
        )
      : null;
    if (peek && peekTile) {
      placeSlot(
        peek,
        peekAnchor({
          tileTop: capsuleTop + peekTile.offsetTop,
          tileHeight: peekTile.offsetHeight,
        }),
      );
      if (peek.dataset.placed === undefined) {
        void peek.offsetTop;
        peek.dataset.placed = "";
      }
    }
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
    // Settings: the menu hangs below the "…" capsule, the flyout beside it
    // and a little higher (the mock's placement).
    const menu = slots.settingsMenu.current;
    if (more && menu) {
      placeSlot(
        menu,
        toolbarTop + more.offsetTop + SETTINGS_MENU_REACH - menu.offsetHeight,
      );
      const fly = slots.settingsFly.current;
      if (fly) {
        placeSlot(fly, Number.parseFloat(menu.style.top) - SETTINGS_FLY_RISE);
      }
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
      slots.peek,
      slots.usage,
      slots.settingsMenu,
      slots.settingsFly,
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
  side: EdgeSide,
  /** Being dragged: the whole frame takes the pointer. */
  dragging: boolean,
) {
  const last = useRef("");
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const sideRef = useRef(side);
  sideRef.current = side;
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;
  const report = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const regions: EdgeHitRegion[] = [];
    const frameRight = root.clientWidth;
    if (draggingRef.current && !hiddenRef.current) {
      regions.push({
        x: 0,
        y: 0,
        width: frameRight,
        height: root.clientHeight,
      });
    }
    const nodes =
      hiddenRef.current || draggingRef.current
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
      const { left, right } = hitSpan(
        box,
        frameRight,
        node.dataset.edgeHit === "to-edge",
        sideRef.current,
      );
      regions.push({
        x: left,
        y: Math.floor(box.top),
        width: right - left,
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

/**
 * Dragging the toolbar (the mock's dragTo/dragEnd): it follows the pointer up
 * and down the edge, and on release it settles on the nearer half of the
 * screen (left or right). A press that moves less than 5 pt is a click.
 * While dragging the whole frame takes the pointer, and the click that ends
 * a drag is swallowed.
 */
function useToolbarDrag(
  toolbarRef: RefObject<HTMLDivElement | null>,
  rootRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    let start: { x: number; y: number; edgeY: number; pointer: number } | null =
      null;
    let dragged = false;
    const swallowClick = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
    };
    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.pointer) return;
      const dx = event.screenX - start.x;
      const dy = event.screenY - start.y;
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      if (!dragged) {
        dragged = true;
        toolbar.setPointerCapture(start.pointer);
        useEdgeToolbarStore.getState().setDragging(true);
      }
      const root = rootRef.current;
      if (!root) return;
      useEdgePrefs
        .getState()
        .setPref(
          "edgeY",
          clampEdgeY(start.edgeY + dy, root.clientHeight, toolbar.offsetHeight),
        );
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.pointer) return;
      start = null;
      if (!dragged) return;
      dragged = false;
      useEdgeToolbarStore.getState().setDragging(false);
      const screen = window.screen as Screen & { availLeft?: number };
      useEdgePrefs
        .getState()
        .setPref(
          "side",
          sideForDrop(event.screenX, screen.availLeft ?? 0, screen.availWidth),
        );
      toolbar.addEventListener("click", swallowClick, {
        capture: true,
        once: true,
      });
      window.setTimeout(
        () => toolbar.removeEventListener("click", swallowClick, true),
        0,
      );
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      start = {
        x: event.screenX,
        y: event.screenY,
        edgeY: useEdgePrefs.getState().edgeY,
        pointer: event.pointerId,
      };
      dragged = false;
    };
    toolbar.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      toolbar.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [toolbarRef, rootRef]);
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
  const expanded = useEdgeToolbarStore((s) => s.expanded);
  const panel = useEdgeToolbarStore((s) => s.panel);
  const pointerInside = useEdgeToolbarStore((s) => s.pointerInside);
  // Nothing joins the capsule or takes a slot there under the user's hand.
  const { sessions, tiles, allDots, tasksById, existing } = useEdgeSessions(
    pointerInside || panel !== null,
  );
  const preview = useEdgeToolbarStore((s) => s.preview);
  const hint = useEdgeToolbarStore((s) => s.hint);
  const collapse = useEdgeToolbarStore((s) => s.collapse);
  const summon = useEdgeToolbarStore((s) => s.summon);
  const openList = useEdgeToolbarStore((s) => s.openList);
  const pickIcon = useEdgeToolbarStore((s) => s.pickIcon);
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
  const peekRef = useRef<HTMLDivElement | null>(null);
  const usageRef = useRef<HTMLDivElement | null>(null);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const settingsFlyRef = useRef<HTMLDivElement | null>(null);
  const slots = useMemo<Slots>(
    () => ({
      card: cardRef,
      list: listRef,
      preview: previewRef,
      peek: peekRef,
      usage: usageRef,
      settingsMenu: settingsMenuRef,
      settingsFly: settingsFlyRef,
    }),
    [],
  );
  const toggleSettings = useEdgeToolbarStore((s) => s.toggleSettings);
  const settingsPage = useEdgeToolbarStore((s) => s.settingsPage);
  const setSettingsPage = useEdgeToolbarStore((s) => s.setSettingsPage);
  const dragging = useEdgeToolbarStore((s) => s.dragging);
  const side = useEdgePrefs((s) => s.side);
  const edgeY = useEdgePrefs((s) => s.edgeY);
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
  // A tile's preview: one frame for every tile (moving between tiles keeps
  // it open and swaps its content), the last session kept while it closes.
  const peekPanel: EdgePanel = panel?.kind === "peek" ? panel : null;
  const peeked = usePanelPresence(peekPanel, "quick", rootRef);
  const lastPeek = useRef<string | null>(null);
  if (panel?.kind === "peek") lastPeek.current = panel.taskId;
  const usagePanel: EdgePanel = panel?.kind === "usage" ? panel : null;
  const usage = usePanelPresence(usagePanel, "quick", rootRef);
  const settingsPanel: EdgePanel = panel?.kind === "settings" ? panel : null;
  const settingsMenu = usePanelPresence(settingsPanel, "quick", rootRef);
  // The flyout shows the open sub-page (and keeps the last one while it
  // plays its exit).
  const flyPanel: EdgePanel =
    settingsPanel && settingsPage ? settingsPanel : null;
  const settingsFly = usePanelPresence(flyPanel, "quick", rootRef);
  const lastSettingsPage = useRef<SettingsPage>("look");
  if (settingsPage) lastSettingsPage.current = settingsPage;
  useEdgeLayout(rootRef, toolbarRef, capsuleRef, slots);
  const hidden = useEdgeToolbarStore((s) => s.hidden);
  useHitRegions(rootRef, hidden, side, dragging);

  // The shell docks the window against the chosen edge; the frame shows
  // once it has (so it never appears on the wrong side first).
  const [sideReady, setSideReady] = useState<EdgeSide | null>(null);
  useEffect(() => {
    let alive = true;
    void setEdgeSide(side).then(() => {
      if (alive) setSideReady(side);
    });
    return () => {
      alive = false;
    };
  }, [side]);
  useToolbarDrag(toolbarRef, rootRef);

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
  const peekCloseTimer = useRef<number | null>(null);
  const cancelPeekClose = useCallback(() => {
    if (peekCloseTimer.current !== null) {
      window.clearTimeout(peekCloseTimer.current);
      peekCloseTimer.current = null;
    }
  }, []);
  const schedulePeekClose = useCallback(() => {
    if (peekCloseTimer.current !== null) return;
    peekCloseTimer.current = window.setTimeout(() => {
      peekCloseTimer.current = null;
      useEdgeToolbarStore.getState().endPeek();
      scheduleCollapse();
    }, COLLAPSE_DELAY_MS);
  }, [scheduleCollapse]);
  useEffect(() => cancelPeekClose, [cancelPeekClose]);

  // The mock's pointer triggers: the tab shows its hint, the capsule opens
  // the session list (only when nothing else is open), a row is previewed.
  const onPointer = useCallback(
    ({ inside, id }: EdgePointer) => {
      const store = useEdgeToolbarStore.getState();
      store.setPointerInside(inside);
      store.setHint(id === "tab");
      // "…" opens while pointed at (the mock's hoverOpens) and folds when
      // left, unless its usage panel is open.
      store.setMoreOpen(id === "more");
      // A settings row with a chevron opens its page on pointing.
      if (id?.startsWith("settings:")) {
        store.setSettingsPage(id.slice("settings:".length) as SettingsPage);
      }
      // A session's tile previews it beside the tile; the capsule between
      // the tiles opens the session list (when nothing else is open).
      if (id?.startsWith("tile:") && store.expanded) {
        cancelCollapse();
        store.peekSession(id.slice("tile:".length));
      } else if (id === "capsule" && !store.panel && store.expanded) {
        cancelCollapse();
        store.openList();
      }
      // The preview stays while the pointer is on a tile, the card or the
      // bridge between them; it closes a moment after leaving them all.
      if (useEdgeToolbarStore.getState().panel?.kind === "peek") {
        if (keepsPeekOpen(id)) cancelPeekClose();
        else schedulePeekClose();
      }
      if (id?.startsWith("row:")) store.previewSession(id.slice(4));
    },
    [cancelCollapse, cancelPeekClose, schedulePeekClose],
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
  // Option twice with chro's own window in front: the session that needs the
  // person after the one opened last time (Unread's order), in that window.
  const lastOpenedInMain = useRef<string | null>(null);
  const unreadIds = sessions.map((session) => session.task.id).join("\n");
  const openNextNeedsYou = useCallback(() => {
    const order = unreadIds ? unreadIds.split("\n") : [];
    const next = nextNeedsYou(order, lastOpenedInMain.current);
    const task = next ? tasksById.get(next) : undefined;
    if (!next || !task) return;
    lastOpenedInMain.current = next;
    openSessionInApp({ projectId: task.project_id, taskId: next });
  }, [unreadIds, tasksById]);
  const { beginTalking, finishTalking, cancelTalking } = voice;
  // A session's own controls (row microphone, panel microphone and camera)
  // talk to or capture for that session.
  const { toggleMic, beginCapture } = voice;
  const voiceActions = useMemo(
    () => ({
      talkTo: (taskId: string) =>
        toggleMic({ kind: "session", taskId } as const),
      captureFor: (taskId: string) =>
        void beginCapture({ kind: "session", taskId } as const),
    }),
    [toggleMic, beginCapture],
  );

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
        // chro's own window is in front (the toolbar is stepped aside): the
        // shell passes only Option twice, which opens the next session that
        // needs the person in that window.
        if (store.hidden) {
          if (gesture === "summon") openNextNeedsYou();
          return;
        }
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
    [
      hasUnread,
      cancelCollapse,
      handleClosePanel,
      beginTalking,
      finishTalking,
      openNextNeedsYou,
    ],
  );

  // "…" items: Settings and Feedback live in the main window; Usage is a
  // panel of its own beside the open capsule.
  const handleMoreItem = useCallback(
    (item: MoreItem) => {
      if (item === "feedback") {
        openAppView(item);
        return;
      }
      // Settings and Usage open beside the "…" capsule (Settings is the
      // edge's own; its last rows lead to chro's full Settings).
      const open = useEdgeToolbarStore.getState().panel?.kind;
      if (open === item) {
        handleClosePanel();
        return;
      }
      cancelCollapse();
      if (open) closePanel();
      if (item === "usage") toggleUsage();
      else toggleSettings();
    },
    [cancelCollapse, closePanel, handleClosePanel, toggleUsage, toggleSettings],
  );
  const handleOpenChroSettings = useCallback(() => {
    openAppView("settings");
    handleClosePanel();
  }, [handleClosePanel]);
  const handleTurnOff = useCallback(() => {
    // The same switch as Settings > Beta features: the main window follows
    // the shared storage and closes this window. A developer force (dev
    // builds) would otherwise keep the toolbar on, so it goes too.
    const flags = useFeatureFlagStore.getState();
    flags.setDevOverride("edge_toolbar", null);
    flags.setBetaEnabled("edge_toolbar", false);
  }, []);

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
      if (
        (open?.kind === "unread" || open?.kind === "session") &&
        event.key === "?"
      ) {
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
  const peekTask = lastPeek.current
    ? tasksById.get(lastPeek.current) ?? null
    : null;
  const peekDot = peekTask
    ? allDots.find((dot) => dot.task.id === peekTask.id)
    : undefined;
  const pinPeek = () => {
    if (!peekTask) return;
    cancelPeekClose();
    handleOpenSession(peekTask.id);
  };

  const previewShown = previewed.shown;
  const previewTask =
    previewShown?.kind === "session"
      ? tasksById.get(previewShown.taskId) ?? null
      : null;
  const previewDot = previewTask
    ? allDots.find((dot) => dot.task.id === previewTask.id)
    : undefined;

  return (
    <EdgeVoiceActionsContext.Provider value={voiceActions}>
      <div
        ref={rootRef}
        data-edge-root
        data-presence={hidden ? "hidden" : "shown"}
        data-side={side}
        data-side-ready={sideReady === side ? "" : undefined}
        data-dragging={dragging ? "" : undefined}
        style={{ "--edge-y": `${edgeY}px` } as CSSProperties}
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
                onPickIcon={(taskId) => {
                  cancelCollapse();
                  pickIcon(taskId);
                }}
              />
            </PanelFrame>
          </div>
        ) : null}
        {settingsMenu.shown ? (
          <div
            ref={settingsMenuRef}
            className="edge-panel-slot"
            data-slot="settings-menu"
            data-edge-hit={settingsMenu.on ? "" : undefined}
          >
            <PanelFrame on={settingsMenu.on} timing="quick">
              <EdgeSettingsMenu
                page={settingsPage}
                onPage={setSettingsPage}
                onOpenChroSettings={handleOpenChroSettings}
                onTurnOff={handleTurnOff}
              />
            </PanelFrame>
          </div>
        ) : null}
        {settingsFly.shown ? (
          <div
            ref={settingsFlyRef}
            className="edge-panel-slot"
            data-slot="settings-fly"
            data-edge-hit={settingsFly.on ? "" : undefined}
          >
            <PanelFrame on={settingsFly.on} timing="quick">
              <EdgeSettingsPage page={lastSettingsPage.current} />
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
              <EdgeSessionPreview
                task={previewTask}
                status={previewDot.status}
              />
            </PanelFrame>
          </div>
        ) : null}
        {peeked.shown && peekTask && peekDot ? (
          <div
            ref={peekRef}
            className="edge-panel-slot"
            data-slot="peek"
            data-peek={peekTask.id}
            data-edge-hit={peeked.on ? "" : undefined}
            data-edge-hover={peeked.on ? "peek" : undefined}
            role="button"
            tabIndex={-1}
            aria-label={peekTask.title || t("sessionUnresolved")}
            // A click pins it: the session's panel, as a click on the tile.
            onClick={pinPeek}
            onKeyDown={(event) => {
              if (event.key === "Enter") pinPeek();
            }}
          >
            {/* The gap to the toolbar belongs to the card, so the pointer
                crosses it without the card closing. */}
            <span
              aria-hidden="true"
              data-edge-hit={peeked.on ? "" : undefined}
              data-edge-hover={peeked.on ? "peek" : undefined}
              className="edge-peek-bridge"
            />
            <PanelFrame on={peeked.on} timing="quick">
              <EdgeSessionPreview task={peekTask} status={peekDot.status} />
            </PanelFrame>
          </div>
        ) : null}
        <EdgeToolbar
          surface={surface}
          tiles={tiles}
          unread={sessions}
          panel={panel}
          pager={panel?.kind === "unread" ? unread : null}
          hint={hint}
          focus={panel?.kind === "peek" ? panel.taskId : null}
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
          onMic={() => voice.toggleMic()}
          onCapture={() => void voice.beginCapture()}
        />
        <EdgeTalkPill
          talk={voice.talk}
          targetTitle={voice.targetTitle}
          onOpenSettings={voice.openSettings}
        />
      </div>
    </EdgeVoiceActionsContext.Provider>
  );
}
