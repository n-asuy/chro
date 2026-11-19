import { useLanguage } from "@/i18n";
import { type RefObject, useLayoutEffect, useRef } from "react";
import type { CapsuleDot } from "../domain/capsule-dots";
import {
  type ToolbarSurface,
  badgeShown,
  dotsToGrow,
  parseCssTime,
} from "../domain/edge-motion";
import {
  type EdgeSession,
  type UnreadPagerView,
  unreadBadge,
} from "../domain/edge-sessions";
import type { EdgePanel } from "../state/edge-toolbar-store";
import { EdgeDot } from "./edge-dot";
import { EdgeMore, type MoreItem } from "./edge-more";
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
 * Dots that join after the first render grow into the capsule (height and
 * opacity, as the mock does); dots present from the start just appear.
 */
function useDotGrowth(
  capsuleRef: RefObject<HTMLDivElement | null>,
  ids: readonly string[],
) {
  const seen = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    const capsule = capsuleRef.current;
    const grow = dotsToGrow(seen.current, ids);
    seen.current = new Set(ids);
    if (!capsule || grow.length === 0) return;
    const style = getComputedStyle(capsule);
    const duration = parseCssTime(
      style.getPropertyValue("--edge-dot-grow"),
      DOT_GROW_FALLBACK_MS,
    );
    const easing =
      style.getPropertyValue("--edge-ease-out").trim() || "ease-out";
    const pitch = style.getPropertyValue("--edge-dot-pitch").trim() || "15px";
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
 * The toolbar in both of its shapes, with the mock's triggers (Dots design).
 * Collapsed, only the capsule shows, narrowed into a tab fused to the screen
 * edge; pointing at it shows a hint, clicking it brings the toolbar out with
 * Unread. Expanded, the Unread button unfolds above the capsule; pointing at
 * the capsule opens the session list, clicking a dot opens that session.
 * The two shapes are one element, so the CSS transitions between them (see
 * `edge-toolbar.css`). Each dot is a session that still exists; the badge
 * pops in on the expanded toolbar when Unread holds something.
 * Labels are native tooltips: in-page ones would pass the window's edge.
 */
export function EdgeToolbar({
  surface,
  dots,
  unread,
  panel,
  pager,
  hint,
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
  /** The capsule's dots (see `capsuleDots`). */
  dots: { shown: readonly CapsuleDot[]; hidden: number };
  /** The sessions in Unread, for the badge. */
  unread: readonly EdgeSession[];
  panel: EdgePanel;
  /** The open Unread pager, so the badge counts what it lists. */
  pager: UnreadPagerView | null;
  /** The pointer is on the collapsed tab. */
  hint: boolean;
  toolbarRef: RefObject<HTMLDivElement | null>;
  capsuleRef: RefObject<HTMLDivElement | null>;
  onSummon: () => void;
  onToggleList: () => void;
  onOpenUnread: () => void;
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
  const badge = unreadBadge(unread, pager);
  const ids = dots.shown.map((dot) => dot.task.id);
  useDotGrowth(capsuleRef, ids);

  const unreadLabel = badge
    ? t("edgeToolbarUnreadCount", { count: badge.count })
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
        <span
          data-edge-badge
          data-on={badgeShown(surface, badge !== null) ? "" : undefined}
          data-status={badge?.status}
          className="edge-badge"
        />
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
        {dots.shown.map((dot, index) => {
          const label = dot.task.title || t("sessionUnresolved");
          return (
            <button
              key={dot.task.id}
              type="button"
              data-edge-dot={dot.task.id}
              title={collapsed ? undefined : label}
              aria-label={label}
              aria-hidden={collapsed || undefined}
              tabIndex={collapsed ? -1 : undefined}
              aria-pressed={
                panel?.kind === "session" && panel.taskId === dot.task.id
              }
              // A click opens the session without leaving focus (and so no
              // ring) on the dot.
              onMouseDown={(event) => event.preventDefault()}
              onClick={collapsed ? undefined : () => onOpenSession(dot.task.id)}
              className="edge-dot-slot"
            >
              <EdgeDot status={dot.status} index={index} />
            </button>
          );
        })}
        {dots.hidden > 0 ? (
          <span
            title={t("edgeToolbarMoreSessions", { count: dots.hidden })}
            className="edge-overflow"
          >
            +{dots.hidden}
          </span>
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
