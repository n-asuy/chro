import { Loader2 } from "lucide-react";
import { memo, useRef, type RefObject } from "react";
import { ConversationEntries } from "../conversation-view";
import type { DisplayEntry } from "../types";

/**
 * TaskConversation renders precomputed conversation entries.
 *
 * Aggregation and pending-state reconciliation happen outside this component so
 * every surface can read from the same session model.
 */
interface TaskConversationProps {
  entries: DisplayEntry[];
  isLoading: boolean;
  error: string | null;
  messagesEndRef?: RefObject<HTMLDivElement | null>;
  onWikilinkClick?: (wikilink: string) => void;
}

export const TaskConversation = memo(function TaskConversation({
  entries,
  isLoading,
  error,
  messagesEndRef,
  onWikilinkClick,
}: TaskConversationProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  if (error && entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (isLoading && entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="show-scrollbar flex-1 overflow-y-auto px-6 py-5"
      style={{ contain: "strict" }}
    >
      <ConversationEntries
        entries={entries}
        endRef={messagesEndRef}
        onWikilinkClick={onWikilinkClick}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
});
