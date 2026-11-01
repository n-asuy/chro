import {
  type PromptEditorHandle,
  getActivePromptScopeId,
  getPromptEditorHandle,
} from "@/session/state/prompt-editor-store";
import { useCallback, useMemo } from "react";
import { titleForTab } from "../components/tab-meta";
import {
  type SessionTarget,
  listSessionTargets,
  sessionTabScopeId,
} from "../lib/session-targets";
import { useLayoutStore } from "../state/layout-store";

/** Target id that opens a fresh session tab instead of an existing one. */
export const NEW_SESSION_TARGET = "new-session";

/**
 * Session tabs another pane can write into, and the action that does it: the
 * content is written to the target's composer draft (mounted or not), then
 * that tab is brought forward with its composer focused so the user can add a
 * sentence and send.
 */
export function useSessionComposerTargets(): {
  targets: SessionTarget[];
  deliver: (
    targetId: string,
    write: (composer: PromptEditorHandle) => void,
  ) => void;
} {
  const root = useLayoutStore((s) => s.layout.root);
  const openTab = useLayoutStore((s) => s.openTab);
  const setActiveTab = useLayoutStore((s) => s.setActiveTab);

  const targets = useMemo(
    () => listSessionTargets(root, getActivePromptScopeId(), titleForTab),
    [root],
  );

  const deliver = useCallback(
    (targetId: string, write: (composer: PromptEditorHandle) => void) => {
      const target = targets.find((candidate) => candidate.tabId === targetId);
      const tabId = target
        ? target.tabId
        : openTab({ type: "session" }, { activate: true });
      const composer = getPromptEditorHandle(sessionTabScopeId(tabId));
      write(composer);
      if (target) setActiveTab(target.leafId, target.tabId);
      // The tab mounts its composer on the next render.
      requestAnimationFrame(() => composer.focus());
    },
    [targets, openTab, setActiveTab],
  );

  return { targets, deliver };
}
