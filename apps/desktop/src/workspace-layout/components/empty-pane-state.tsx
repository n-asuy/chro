import { SingleAgentSessionView } from "@/session/single-agent-session";

/**
 * Shown when a pane has no tabs. Mirrors the project Home: the start-a-session
 * surface with a ready prompt composer, so a new session can begin in place
 * without navigating anywhere first.
 */
export function EmptyPaneState() {
  return <SingleAgentSessionView forceNewSession />;
}
