
import { Loader2 } from "lucide-react";
import { memo, useMemo, useRef } from "react";
import { ConversationEntries } from "../conversation-view";
import { useConversationHistory } from "../hooks/use-conversation-history";

/**
 * TaskConversation - Aggregates entries from ALL TaskRuns for a Task
 *
 * This component uses useConversationHistory to aggregate conversation entries
 * from all TaskRuns belonging to a Task. Each follow-up message creates a new
 * TaskRun, and this component shows the complete conversation.
 *
 * Features:
 * - Loads historic entries from completed TaskRuns
 * - Streams live entries from running TaskRun
 * - Displays user_message entries (from UserPrompt logs)
 * - Shows loading indicator when streaming
 */
interface TaskConversationProps {
  taskId: string;
  messagesEndRef?: React.RefObject<HTMLDivElement | null>;
  onWikilinkClick?: (wikilink: string) => void;
  onFinished?: () => void;
}

export const TaskConversation = memo(function TaskConversation({
  taskId,
  messagesEndRef,
  onWikilinkClick,
  onFinished,
}: TaskConversationProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { entries, isLoading, error } = useConversationHistory({
    taskId,
    enabled: Boolean(taskId),
    callbacks: {
      onFinished,
    },
  });

  // NOTE: useConversationHistory already adds loading-patch entry when streaming
  const displayEntries = useMemo(() => {
    return entries.filter((entry) => {
      if (entry.type === "STDOUT" || entry.type === "STDERR") return true;
      if (entry.type === "NORMALIZED_ENTRY") {
        return entry.content && entry.content.entry_type;
      }
      return false;
    });
  }, [entries]);

  if (error) {
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
        entries={displayEntries}
        endRef={messagesEndRef}
        onWikilinkClick={onWikilinkClick}
        scrollContainerRef={scrollContainerRef}
      />
    </div>
  );
});
