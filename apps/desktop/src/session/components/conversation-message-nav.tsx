/**
 * ChatGPT-style rail pinned to the right edge of the conversation. Renders one
 * tick per past user message; hovering expands the rail into a list of message
 * previews that scroll the conversation back to the selected turn.
 *
 * The item list is derived from the conversation entries (the source of truth)
 * rather than the rendered DOM, so every turn is reachable even while tail
 * virtualization keeps older turns unmounted. Navigating to a turn that is not
 * currently mounted asks the host to mount the full conversation first, then
 * retries the scroll once the node appears.
 */

import { useLanguage } from "@/i18n";
import { cn } from "@/lib/cn";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { DisplayEntry } from "../types";
import { parseContextFromContent } from "../types/context";

const USER_MESSAGE_ID_ATTR = "data-user-message-id";
/** Gap above the target message after scrolling, so it is not flush to the top. */
const SCROLL_TOP_GAP = 8;
/**
 * A turn counts as "current" once its sticky header sits within this many pixels
 * of the viewport top. Comfortably covers the pinned header's resting position
 * without flipping to the next turn too early.
 */
const ACTIVE_THRESHOLD = 48;
/** Frames to keep retrying a scroll while the full conversation mounts. */
const MOUNT_RETRY_FRAMES = 40;

interface NavItem {
  id: string;
  label: string;
}

const deriveLabel = (content: string): string => {
  const { text } = parseContextFromContent(content);
  const firstLine = text
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
  const base = firstLine && firstLine.length > 0 ? firstLine : content.trim();
  return base;
};

interface ConversationMessageNavProps {
  entries: DisplayEntry[];
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  /**
   * Asks the host to bypass tail virtualization and mount every entry, so a
   * navigation target that scrolled out of the rendered window can be reached.
   */
  onEnsureAllMounted: () => void;
  /** Changes when the host swaps conversations, re-binding the scroll listener. */
  resetKey: unknown;
}

export function ConversationMessageNav({
  entries,
  scrollContainerRef,
  onEnsureAllMounted,
  resetKey,
}: ConversationMessageNavProps) {
  const { t } = useLanguage();
  const [activeId, setActiveId] = useState<string | null>(null);
  const navTokenRef = useRef(0);

  const items = useMemo<NavItem[]>(() => {
    const result: NavItem[] = [];
    for (const entry of entries) {
      if (
        entry.type === "NORMALIZED_ENTRY" &&
        entry.content.entry_type.type === "user_message"
      ) {
        result.push({
          id: entry.key,
          label: deriveLabel(entry.content.content),
        });
      }
    }
    return result;
  }, [entries]);

  const findNode = useCallback(
    (id: string): HTMLElement | null => {
      const container = scrollContainerRef.current;
      if (!container) return null;
      return container.querySelector<HTMLElement>(
        `[${USER_MESSAGE_ID_ATTR}="${CSS.escape(id)}"]`,
      );
    },
    [scrollContainerRef],
  );

  const scrollToNode = useCallback(
    (node: HTMLElement) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const delta =
        node.getBoundingClientRect().top -
        container.getBoundingClientRect().top;
      container.scrollTo({
        top: Math.max(0, container.scrollTop + delta - SCROLL_TOP_GAP),
        behavior: "smooth",
      });
    },
    [scrollContainerRef],
  );

  const navigateTo = useCallback(
    (id: string) => {
      setActiveId(id);
      const token = ++navTokenRef.current;

      const node = findNode(id);
      if (node) {
        scrollToNode(node);
        return;
      }

      // Target is virtualized out: mount the full conversation, then retry the
      // scroll across the next few frames until the node is committed.
      onEnsureAllMounted();
      const attempt = (frame: number) => {
        if (navTokenRef.current !== token) return;
        const mounted = findNode(id);
        if (mounted) {
          scrollToNode(mounted);
          return;
        }
        if (frame >= MOUNT_RETRY_FRAMES) return;
        requestAnimationFrame(() => attempt(frame + 1));
      };
      requestAnimationFrame(() => attempt(0));
    },
    [findNode, scrollToNode, onEnsureAllMounted],
  );

  // Track which turn is currently at the top of the viewport so the rail can
  // highlight it. Local to this component so per-frame scroll updates never
  // re-render the heavy session container.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let raf = 0;
    const recompute = () => {
      raf = 0;
      const nodes = container.querySelectorAll<HTMLElement>(
        `[${USER_MESSAGE_ID_ATTR}]`,
      );
      if (nodes.length === 0) return;
      const containerTop = container.getBoundingClientRect().top;
      let active = nodes[0].getAttribute(USER_MESSAGE_ID_ATTR);
      for (const node of nodes) {
        if (
          node.getBoundingClientRect().top - containerTop <=
          ACTIVE_THRESHOLD
        ) {
          active = node.getAttribute(USER_MESSAGE_ID_ATTR);
        } else {
          break;
        }
      }
      if (active) setActiveId((prev) => (prev === active ? prev : active));
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(recompute);
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    recompute();
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // resetKey re-binds to the new scroll container on session switch;
    // items.length re-seeds the active turn when the turn count changes.
  }, [scrollContainerRef, resetKey, items.length]);

  // A single turn needs no navigation affordance.
  if (items.length < 2) return null;

  return (
    <nav
      aria-label={t("conversationMessageNavLabel")}
      className="pointer-events-none absolute right-3 top-1/2 z-20 flex -translate-y-1/2 justify-end"
    >
      <div className="group/msgnav pointer-events-auto relative flex max-h-[70vh] items-center">
        <div className="flex max-h-[70vh] flex-col items-end gap-1.5 overflow-hidden py-2 pr-1 transition-opacity duration-150 group-hover/msgnav:opacity-0">
          {items.map((item) => (
            <span
              key={item.id}
              className={cn(
                "h-[2px] rounded-full transition-all duration-150",
                item.id === activeId
                  ? "w-4 bg-foreground"
                  : "w-2.5 bg-muted-foreground/40",
              )}
            />
          ))}
        </div>
        <div className="pointer-events-none absolute right-0 top-1/2 max-h-[70vh] w-64 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-background p-1 opacity-0 shadow-lg transition-opacity duration-150 group-hover/msgnav:pointer-events-auto group-hover/msgnav:opacity-100">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => navigateTo(item.id)}
              title={item.label}
              className={cn(
                "block w-full truncate rounded-md px-2.5 py-1.5 text-left text-[13px] leading-snug transition-colors",
                item.id === activeId
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
