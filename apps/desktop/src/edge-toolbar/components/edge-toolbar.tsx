import { useLanguage } from "@/i18n";
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { CapsuleTiles } from "../domain/capsule-slots";
import {
  type ToolbarSurface,
  dotsToGrow,
  parseCssTime,
} from "../domain/edge-motion";
import {
  type EdgeSession,
  type UnreadPagerView,
  unreadRing,
} from "../domain/edge-sessions";
import { taskIcon } from "../domain/task-icons";
import type { EdgePanel } from "../state/edge-toolbar-store";
import { EdgeMore, type MoreItem } from "./edge-more";
import { EdgeRing } from "./edge-ring";
import { EdgeTabRing } from "./edge-tab-ring";
import { EdgeTaskIcon } from "./edge-task-icon";
import { EdgeTools } from "./edge-tools";

/** Used when the stylesheet's value cannot be read. */
const DOT_GROW_FALLBACK_MS = 320;

/** Id of a dot's grow-in animation, so layout can wait for it. */
export const DOT_GROW_ANIMATION = "edge-dot-grow";

/** Dispatched on the capsule when a dot has grown in. */
export const DOT_GROWN_EVENT = "edge-dot-grown";

/** The inbox tray, drawn on a 24-unit grid like the toolbar's other glyphs. */
function TrayGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="edge-glyph"
    >
      <path d="M3.75 13.25v4a2.5 2.5 0 0 0 2.5 2.5h11.5a2.5 2.5 0 0 0 2.5-2.5v-4" />
      <path d="M3.75 13.25 6.1 6.3A2.2 2.2 0 0 1 8.2 4.75h7.6a2.2 2.2 0 0 1 2.1 1.55l2.35 6.95" />
      <path d="M3.75 13.25h4.4l1.2 2.5h5.3l1.2-2.5h4.4" />
    </svg>
  );
}

/**
 * Dots appended after the first render grow into the capsule (height and
 * opacity, as the mock does); dots present from the start, and a dot taking
 * another's slot, just appear.
 */
function useDotGrowth(
  capsuleRef: RefObject<HTMLDivElement | null>,
  ids: readonly string[],
) {
  const before = useRef<readonly string[] | null>(null);
  useLayoutEffect(() => {
    const capsule = capsuleRef.current;
    const grow = dotsToGrow(before.current, ids);
    before.current = ids;
    if (!capsule || grow.length === 0) return;
    const style = getComputedStyle(capsule);
    const duration = parseCssTime(
      style.getPropertyValue("--edge-dot-grow"),
      DOT_GROW_FALLBACK_MS,
    );
    const easing =
      style.getPropertyValue("--edge-ease-out").trim() || "ease-out";
    // The slot's height on the capsule's current shape (a dot's on the tab,
    // a tile's on the expanded capsule).
    const pitch = style.getPropertyValue("--edge-slot-h").trim() || "15px";
    for (const id of grow) {
      const slot = capsule.querySelector<HTMLElement>(
        `[data-edge-dot="${CSS.escape(id)}"]`,
      );
      const growth = slot?.animate(
        [
          { height: "0px", opacity: 0 },
          { height: pitch, opacity: 1 },
        ],
        { duration, easing, id: DOT_GROW_ANIMATION },
      );
      // The toolbar keeps its anchor while the dot grows (the capsule grows
      // downward) and settles on the new centre once it has.
      growth?.finished
        .then(() =>
          capsule.dispatchEvent(new Event(DOT_GROWN_EVENT, { bubbles: true })),
        )
        .catch(() => {});
    }
  }, [capsuleRef, ids]);
}

/**
 * The toolbar in both of its shapes, with the mock's triggers. Collapsed,
 * only the capsule shows, narrowed into a tab fused to the screen edge, one
 * dot per session it shows; pointing at it shows a hint, clicking it brings
 * the toolbar out with Unread. Expanded, the Unread button unfolds above the
 * capsule and each session is a tile (its icon inside the ring of its
 * state); pointing at a tile previews that session beside it, clicking it
 * pins the session's panel, and pointing at or clicking the capsule between
 * the tiles opens the session list. The two shapes are one element, so
 * the CSS transitions between them (see `edge-toolbar.css`); the Unread
 * button carries a thin ring while Unread holds something.
 */
export function EdgeToolbar({
  surface,
  tiles,
  unread,
  panel,
  pager,
  hint,
  focus,
  toolbarRef,
  capsuleRef,
  onSummon,
  onToggleList,
  onOpenUnread,
  onOpenSession,
  moreOpen,
  onOpenMore,
  onMoreItem,
  recording,
  onMic,
  onCapture,
}: {
  surface: ToolbarSurface;
  /** The sessions on the edge and what is off it (see `capsuleTiles`). */
  tiles: CapsuleTiles;
  /** The sessions in Unread, for the button's ring and label. */
  unread: readonly EdgeSession[];
  panel: EdgePanel;
  /** The open Unread pager, so the label counts what it lists. */
  pager: UnreadPagerView | null;
  /** The pointer is on the collapsed tab. */
  hint: boolean;
  /** The session whose tile is previewed (its tile is lit). */
  focus: string | null;
  toolbarRef: RefObject<HTMLDivElement | null>;
  capsuleRef: RefObject<HTMLDivElement | null>;
  onSummon: () => void;
  onToggleList: () => void;
  onOpenUnread: () => void;
  /** A tile was clicked: that session's compact panel. */
  onOpenSession: (taskId: string) => void;
  /** The "…" capsule is open. */
  moreOpen: boolean;
  onOpenMore: () => void;
  onMoreItem: (item: MoreItem) => void;
  /** The microphone is on. */
  recording: boolean;
  onMic: () => void;
  onCapture: () => void;
}) {
  const { t } = useLanguage();
  const collapsed = surface === "collapsed";
  const unreadState = unreadRing(unread, pager);
  const ids = tiles.shown.map((dot) => dot.task.id);
  useDotGrowth(capsuleRef, ids);

  const unreadLabel = unreadState
    ? t("edgeToolbarUnreadCount", { count: unreadState.count })
    : t("edgeToolbarUnread");

  return (
    <div
      ref={toolbarRef}
      data-edge-toolbar
      data-surface={surface}
      data-edge-hit={collapsed ? undefined : "to-edge"}
      className="edge-toolbar"
    >
      <button
        type="button"
        title={unreadLabel}
        aria-label={unreadLabel}
        aria-pressed={panel?.kind === "unread"}
        aria-hidden={collapsed || undefined}
        tabIndex={collapsed ? -1 : undefined}
        onClick={onOpenUnread}
        className="edge-chrome edge-round edge-inbox"
      >
        <TrayGlyph />
        {/* The capsule's quiet ring, inside the button: amber while
            something needs the user, green for finished results only. */}
        {unreadState ? (
          <svg
            viewBox="0 0 28 28"
            aria-hidden="true"
            data-edge-unread-ring={unreadState.ring}
            className="edge-unread-ring"
          >
            <circle cx="14" cy="14" r="13.25" data-status={unreadState.ring} />
          </svg>
        ) : null}
      </button>
      {/* Collapsed, the whole capsule is the tab's one target. */}
      <div
        ref={capsuleRef}
        data-edge-tab={collapsed ? "" : undefined}
        data-edge-hit={collapsed ? "" : undefined}
        data-edge-hover={collapsed ? "tab" : "capsule"}
        role={collapsed ? "button" : undefined}
        tabIndex={collapsed ? 0 : undefined}
        aria-label={collapsed ? t("edgeToolbarUnread") : undefined}
        onClick={(event) => {
          if (collapsed) onSummon();
          else if (!(event.target as Element).closest("[data-edge-dot]")) {
            onToggleList();
          }
        }}
        onKeyDown={
          collapsed
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSummon();
                }
              }
            : undefined
        }
        className="edge-chrome edge-capsule"
      >
        <span className="edge-flare" data-side="top" />
        <span className="edge-flare" data-side="bottom" />
        {tiles.shown.map((dot) => {
          const { task } = dot;
          const label = task.title || t("sessionUnresolved");
          const open = panel?.kind === "session" && panel.taskId === task.id;
          return (
            <button
              key={task.id}
              type="button"
              data-edge-dot={task.id}
              data-edge-hover={collapsed ? undefined : `tile:${task.id}`}
              data-focused={focus === task.id || open ? "" : undefined}
              title={collapsed ? undefined : label}
              aria-label={label}
              aria-hidden={collapsed || undefined}
              tabIndex={collapsed ? -1 : undefined}
              aria-pressed={open}
              // A click opens the session without leaving focus (and so no
              // ring) on the slot.
              onMouseDown={(event) => event.preventDefault()}
              onClick={collapsed ? undefined : () => onOpenSession(task.id)}
              className="edge-dot-slot"
            >
              {/* The tab shows the session's small ring (faint grey once read);
                  the expanded capsule its icon inside the ring of its state
                  (none once read). */}
              <EdgeTabRing status={dot.status} />
              <span className="edge-tile" aria-hidden="true">
                <EdgeTaskIcon name={taskIcon(task.icon)} />
                <EdgeRing status={dot.status} />
              </span>
            </button>
          );
        })}
        {tiles.hidden > 0 ? (
          <span
            title={t("edgeToolbarMoreSessions", { count: tiles.hidden })}
            className="edge-overflow"
          >
            +{tiles.hidden}
          </span>
        ) : null}
        {/* On the tab, sessions that need a look but did not fit: one tick,
            never text (nothing may stick out of the tab). */}
        {tiles.overflow ? (
          <span aria-hidden="true" className="edge-tab-tick" />
        ) : null}
      </div>
      <EdgeTools
        collapsed={collapsed}
        recording={recording}
        onMic={onMic}
        onCapture={onCapture}
      />
      <EdgeMore
        open={moreOpen && !collapsed}
        collapsed={collapsed}
        selected={panel?.kind === "usage" ? "usage" : null}
        onOpen={onOpenMore}
        onItem={onMoreItem}
      />
      <div
        className="edge-hint"
        data-on={hint ? "" : undefined}
        aria-hidden="true"
      >
        {t("edgeToolbarHint")}
      </div>
    </div>
  );
}
