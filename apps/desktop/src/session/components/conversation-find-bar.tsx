/**
 * Floating find bar for the session conversation. Renders the shared FindBar
 * (same UI as the file editor) and wires it to the find controller.
 */

import { FindBar } from "@/components/find-bar";
import type { ConversationFindController } from "../hooks/use-conversation-find";

interface ConversationFindBarProps {
  controller: ConversationFindController;
}

export function ConversationFindBar({ controller }: ConversationFindBarProps) {
  if (!controller.isOpen) return null;

  return (
    <div className="chro-conversation-find">
      <FindBar
        query={controller.query}
        onQueryChange={controller.setQuery}
        onNext={controller.next}
        onPrevious={controller.previous}
        onClose={controller.close}
        matchLabel={controller.matchLabel}
        ariaLabel="Find in conversation"
        placeholder="Find in conversation..."
        focusSignal={controller.focusSignal}
      />
    </div>
  );
}
