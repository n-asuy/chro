import { useLanguage } from "@/i18n";
import type { StoredTask } from "@/session/types";
import { useEffect, useRef } from "react";
import { cardEnters } from "../domain/edge-motion";
import type { EdgeSession } from "../domain/edge-sessions";
import { useEdgeToolbarStore } from "../state/edge-toolbar-store";
import { EdgeKeyboardHelp } from "./edge-keyboard-help";
import { EdgePanelHeader } from "./edge-panel-header";
import { usePanelReady } from "./edge-panel-ready";
import {
  EdgePanelContent,
  EdgeSessionPanel,
  edgePanelHeight,
} from "./edge-session-panel";

/** Height of the panel when Unread has nothing to show. */
const EMPTY_PANEL_HEIGHT = 200;

/**
 * Unread: a pager over the sessions that need the user, one compact session
 * panel at a time. Sessions waiting on a question or approval come first,
 * then finished ones the user has not seen. J/K step back and forward, Esc
 * closes. A finished session counts as read once shown, and leaves the list
 * when the pager closes.
 */
export function UnreadPager({
  sessions,
  tasksById,
  existing,
  onClose,
}: {
  sessions: readonly EdgeSession[];
  tasksById: ReadonlyMap<string, StoredTask>;
  existing: ReadonlySet<string>;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const syncUnread = useEdgeToolbarStore((s) => s.syncUnread);
  const stepUnread = useEdgeToolbarStore((s) => s.stepUnread);
  const help = useEdgeToolbarStore((s) => s.help);
  const toggleHelp = useEdgeToolbarStore((s) => s.toggleHelp);
  const { order, cursorId } = useEdgeToolbarStore((s) => s.unread);

  useEffect(() => {
    syncUnread(sessions, existing);
  }, [syncUnread, sessions, existing]);

  const task = cursorId ? tasksById.get(cursorId) ?? null : null;

  // The item before this one, to crossfade when the pager moves on.
  const previousId = useRef<string | null>(null);
  const enter = cardEnters(previousId.current, task?.id ?? null);
  useEffect(() => {
    previousId.current = task?.id ?? null;
  }, [task?.id]);

  // An empty pager has nothing to load; a session panel reports itself.
  usePanelReady(!task);

  if (!task) {
    const title = t("edgeToolbarUnread");
    return (
      <EdgePanelContent
        label={title}
        height={Math.min(EMPTY_PANEL_HEIGHT, edgePanelHeight())}
      >
        <EdgePanelHeader
          title={title}
          help={help}
          onToggleHelp={toggleHelp}
          onClose={onClose}
        />
        {help ? (
          <EdgeKeyboardHelp paging={false} />
        ) : (
          <p className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-custom-text-300">
            {t("edgeToolbarUnreadEmpty")}
          </p>
        )}
      </EdgePanelContent>
    );
  }

  // Keyed by session: each item gets a fresh panel (streams, scroll, draft).
  return (
    <EdgeSessionPanel
      key={task.id}
      task={task}
      onClose={onClose}
      pager={{ order, cursorId, onStep: stepUnread }}
      enter={enter}
    />
  );
}
