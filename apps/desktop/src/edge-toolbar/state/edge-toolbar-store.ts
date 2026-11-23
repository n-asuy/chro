import { create } from "zustand";
import {
  type EdgeSession,
  nextUnreadOrder,
  resolveCursor,
  stepCursor,
} from "../domain/edge-sessions";
import {
  TALK_IDLE,
  type TalkState,
  type TalkTarget,
  beginTalk,
} from "../domain/talk";

/** What is open beside the toolbar. */
export type EdgePanel =
  | { kind: "unread" }
  | { kind: "session"; taskId: string }
  | { kind: "list" }
  /** A tile under the pointer: that session's preview beside the tile. */
  | { kind: "peek"; taskId: string }
  | { kind: "usage" }
  | { kind: "settings" }
  | null;

/** A sub-page of the edge settings, shown in the flyout beside the menu. */
export type SettingsPage = "look" | "language";

interface UnreadPagerState {
  order: string[];
  cursorId: string | null;
  /** Index of the cursor, used to land on the neighbour when its item leaves. */
  cursorIndex: number;
  /** Items shown since the pager opened; they keep their place until it closes. */
  shown: string[];
}

const CLOSED_PAGER: UnreadPagerState = {
  order: [],
  cursorId: null,
  cursorIndex: 0,
  shown: [],
};

interface EdgeToolbarState {
  /** The toolbar is out (otherwise only the slim tab shows). */
  expanded: boolean;
  panel: EdgePanel;
  /** The keyboard help is shown in place of the open panel's body. */
  help: boolean;
  /** The session previewed beside the list (the row under the pointer). */
  preview: string | null;
  /** The collapsed tab's hint is showing (the pointer is on the tab). */
  hint: boolean;
  /** The "…" capsule is open, showing its items. */
  moreOpen: boolean;
  unread: UnreadPagerState;
  /** Press to talk: the talk pill's state. */
  talk: TalkState;
  /** Stepped aside: chro's own window is in front. */
  hidden: boolean;
  /** The settings flyout's open sub-page, if any. */
  settingsPage: SettingsPage | null;
  /** The session whose compact panel shows the icon picker. */
  iconPicker: string | null;
  /** The toolbar is being dragged (the whole frame takes the pointer). */
  dragging: boolean;
  /** The pointer is on the toolbar or on one of its panels. */
  pointerInside: boolean;
  expand: () => void;
  collapse: () => void;
  /** A click on the collapsed tab: the toolbar comes out with Unread. */
  summon: () => void;
  /** The capsule under the pointer opens the session list, if nothing else is open. */
  openList: () => void;
  previewSession: (taskId: string) => void;
  setHint: (on: boolean) => void;
  /** Open or close the "…" capsule; it stays open while its usage panel is. */
  setMoreOpen: (on: boolean) => void;
  /** "…" → Usage: open or close the usage panel. */
  toggleUsage: () => void;
  /** "…" → Settings: open or close the edge settings. */
  toggleSettings: () => void;
  /** Show a settings sub-page beside the menu (null closes it). */
  setSettingsPage: (page: SettingsPage | null) => void;
  /**
   * A capsule tile under the pointer: that session's preview opens beside
   * the tile, or the open preview swaps to it. It replaces nothing pinned
   * (a session panel, Unread, Usage, Settings), only the list or a preview.
   * Pointing never marks the session read.
   */
  peekSession: (taskId: string) => void;
  /** The pointer has left the tile and its preview: the preview closes. */
  endPeek: () => void;
  /** Show or hide the icon picker in the card showing `taskId`. */
  toggleIconPicker: (taskId: string) => void;
  /** A session row's context menu: its compact panel with the icon picker. */
  pickIcon: (taskId: string) => void;
  setDragging: (dragging: boolean) => void;
  setPointerInside: (inside: boolean) => void;
  openUnread: () => void;
  openSession: (taskId: string) => void;
  closePanel: () => void;
  /** `?`: show or hide the keyboard help of the open panel. */
  toggleHelp: () => void;
  /** Recompute the pager after sessions changed. */
  syncUnread: (
    sessions: readonly EdgeSession[],
    existing: ReadonlySet<string>,
  ) => void;
  /** J (-1) / K (+1). */
  stepUnread: (delta: 1 | -1) => void;
  /**
   * Start talking to `target`: the toolbar comes out and any panel closes,
   * the talk pill taking its place (the mock's startTalk).
   */
  startTalking: (target: TalkTarget) => void;
  setTalk: (talk: TalkState) => void;
  /**
   * chro's window came to the front (true) or left it (false). Stepping
   * aside closes whatever is open and folds the toolbar, so it comes back
   * as the collapsed tab.
   */
  setHidden: (hidden: boolean) => void;
}

/** Point the pager at `cursorId`; showing an item marks it shown. */
function withCursor(
  pager: UnreadPagerState,
  cursorId: string | null,
): UnreadPagerState {
  const cursorIndex = cursorId ? pager.order.indexOf(cursorId) : 0;
  const shown =
    cursorId && !pager.shown.includes(cursorId)
      ? [...pager.shown, cursorId]
      : pager.shown;
  if (
    cursorId === pager.cursorId &&
    cursorIndex === pager.cursorIndex &&
    shown === pager.shown
  ) {
    return pager;
  }
  return { ...pager, cursorId, cursorIndex, shown };
}

export const useEdgeToolbarStore = create<EdgeToolbarState>()((set, get) => ({
  expanded: false,
  panel: null,
  help: false,
  preview: null,
  hint: false,
  moreOpen: false,
  unread: CLOSED_PAGER,
  talk: TALK_IDLE,
  hidden: false,
  settingsPage: null,
  iconPicker: null,
  dragging: false,
  pointerInside: false,

  expand: () => {
    if (!get().expanded) set({ expanded: true });
  },
  collapse: () => {
    if (get().panel || get().talk.phase !== "idle") return;
    if (get().expanded) set({ expanded: false, moreOpen: false });
  },
  openUnread: () =>
    set({
      expanded: true,
      panel: { kind: "unread" },
      help: false,
      preview: null,
      hint: false,
      moreOpen: false,
      unread: CLOSED_PAGER,
    }),
  openSession: (taskId) =>
    set({
      expanded: true,
      panel: { kind: "session", taskId },
      iconPicker: get().iconPicker === taskId ? taskId : null,
      help: false,
      preview: null,
      hint: false,
      moreOpen: false,
      unread: CLOSED_PAGER,
    }),
  // The pager and help stay as they were, so the closing panel keeps its
  // content while its exit transition plays; the next open starts afresh
  // (that is when a session read in the pager leaves the list).
  closePanel: () =>
    set({
      panel: null,
      preview: null,
      moreOpen: false,
      settingsPage: null,
      iconPicker: null,
    }),
  setMoreOpen: (on) => {
    const { expanded, panel, moreOpen } = get();
    if (on && !expanded && !panel) return;
    if (!on && (panel?.kind === "usage" || panel?.kind === "settings")) return;
    if (on !== moreOpen) set({ moreOpen: on });
  },
  toggleUsage: () => {
    if (get().panel?.kind === "usage") {
      set({ panel: null });
      return;
    }
    set({
      expanded: true,
      panel: { kind: "usage" },
      preview: null,
      hint: false,
      moreOpen: true,
    });
  },
  toggleSettings: () => {
    if (get().panel?.kind === "settings") {
      set({ panel: null, settingsPage: null });
      return;
    }
    set({
      expanded: true,
      panel: { kind: "settings" },
      settingsPage: null,
      preview: null,
      hint: false,
      moreOpen: true,
    });
  },
  setSettingsPage: (page) => {
    if (get().panel?.kind !== "settings" || get().settingsPage === page) return;
    set({ settingsPage: page });
  },
  peekSession: (taskId) => {
    const { panel, expanded, hidden } = get();
    if (hidden || !expanded) return;
    if (panel && panel.kind !== "list" && panel.kind !== "peek") return;
    if (panel?.kind === "peek" && panel.taskId === taskId) return;
    set({ panel: { kind: "peek", taskId }, preview: null, hint: false });
  },
  endPeek: () => {
    if (get().panel?.kind === "peek") set({ panel: null });
  },
  toggleIconPicker: (taskId) => {
    const { panel, iconPicker, unread } = get();
    // The card shows the session: its own panel, or Unread's current one.
    const shown =
      panel?.kind === "session"
        ? panel.taskId
        : panel?.kind === "unread"
          ? unread.cursorId
          : null;
    if (shown !== taskId) return;
    set({ iconPicker: iconPicker === taskId ? null : taskId });
  },
  pickIcon: (taskId) => {
    get().openSession(taskId);
    set({ iconPicker: taskId });
  },
  setDragging: (dragging) => {
    if (get().dragging !== dragging) set({ dragging });
  },
  setPointerInside: (pointerInside) => {
    if (get().pointerInside !== pointerInside) set({ pointerInside });
  },
  summon: () => get().openUnread(),
  openList: () => {
    if (get().panel) return;
    set({
      expanded: true,
      panel: { kind: "list" },
      preview: null,
      hint: false,
    });
  },
  previewSession: (taskId) => {
    const { panel, preview } = get();
    if (panel?.kind === "list" && preview !== taskId) set({ preview: taskId });
  },
  setHint: (on) => {
    const { expanded, panel, hint } = get();
    const next = on && !expanded && !panel;
    if (next !== hint) set({ hint: next });
  },
  toggleHelp: () => {
    if (get().panel) set({ help: !get().help });
  },

  syncUnread: (sessions, existing) => {
    const { panel, unread } = get();
    if (panel?.kind !== "unread") return;
    const order = nextUnreadOrder({
      previous: unread.order,
      sessions,
      shown: new Set(unread.shown),
      existing,
    });
    const reordered = order === unread.order ? unread : { ...unread, order };
    const cursorId = resolveCursor(
      order,
      reordered.cursorId,
      reordered.cursorIndex,
    );
    const next = withCursor(reordered, cursorId);
    if (next !== unread) set({ unread: next });
  },

  stepUnread: (delta) => {
    const { unread } = get();
    const cursorId = stepCursor(unread.order, unread.cursorId, delta);
    const next = withCursor(unread, cursorId);
    if (next !== unread) set({ unread: next });
  },

  startTalking: (target) => {
    const talk = beginTalk(get().talk, target);
    if (talk === get().talk) return;
    set({
      talk,
      expanded: true,
      panel: null,
      preview: null,
      hint: false,
      moreOpen: false,
    });
  },
  setTalk: (talk) => {
    if (talk !== get().talk) set({ talk });
  },
  setHidden: (hidden) => {
    if (hidden === get().hidden) return;
    if (!hidden) {
      set({ hidden: false });
      return;
    }
    set({
      hidden: true,
      expanded: false,
      panel: null,
      help: false,
      preview: null,
      hint: false,
      moreOpen: false,
      talk: TALK_IDLE,
      settingsPage: null,
      iconPicker: null,
    });
  },
}));

// Development builds expose the store, so a headless check can put the
// toolbar in a state that needs the shell (listening, sent) and look at it.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __edgeToolbar?: unknown }).__edgeToolbar =
    useEdgeToolbarStore;
}
