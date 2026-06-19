import { createContext, useContext } from "react";

/**
 * Actions a conversation entry can trigger on the surrounding session.
 *
 * Provided by the session shell and consumed by deeply-nested, memoized entry
 * renderers via context, so a rarely-used affordance (e.g. the malformed
 * tool-call retry button) does not have to be threaded through every list,
 * group and row component as a prop.
 */
export type ConversationActions = {
  /**
   * Re-prompt the agent to continue after a turn aborted on a malformed tool
   * call. Undefined when the surface cannot send follow-ups (e.g. read-only
   * replay), in which case the retry affordance is hidden.
   */
  onRetryMalformedToolCall?: () => void;
};

export const ConversationActionsContext = createContext<ConversationActions>(
  {},
);

export const useConversationActions = (): ConversationActions =>
  useContext(ConversationActionsContext);
