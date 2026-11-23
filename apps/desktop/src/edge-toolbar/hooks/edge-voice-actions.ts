import { createContext, useContext } from "react";

/**
 * Talking to or capturing for one session, from the controls that belong to
 * it (a session row's microphone, the compact panel's microphone and
 * camera). Provided by the toolbar, which owns the voice input.
 */
export interface EdgeVoiceActions {
  /** Start talking to the session, or finish talking if already talking. */
  talkTo: (taskId: string) => void;
  /** Point at a region and ask the session about it. */
  captureFor: (taskId: string) => void;
}

const NONE: EdgeVoiceActions = { talkTo: () => {}, captureFor: () => {} };

export const EdgeVoiceActionsContext = createContext<EdgeVoiceActions>(NONE);

export function useEdgeVoiceActions(): EdgeVoiceActions {
  return useContext(EdgeVoiceActionsContext);
}
