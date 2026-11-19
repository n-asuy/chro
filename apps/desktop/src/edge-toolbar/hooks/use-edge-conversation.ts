import { selectTargetTaskRun } from "@/session/domain/task-run-selection";
import { useConversationHistory } from "@/session/hooks/use-conversation-history";
import { useTaskRunsStream } from "@/session/hooks/use-task-runs-stream";
import { useTaskSessionsStream } from "@/session/hooks/use-task-sessions-stream";
import { useMemo } from "react";

/**
 * One session's conversation for the edge surfaces (the compact panel and
 * the list's hover preview): its runs, the run a follow-up continues, and the
 * conversation entries, streamed like the session window does.
 */
export function useEdgeConversation(taskId: string, scope: string) {
  const {
    runs: taskRuns,
    isLoading: runsLoading,
    error: runsError,
  } = useTaskRunsStream({ taskId });
  const {
    sessions,
    isLoading: sessionsLoading,
    error: sessionsError,
  } = useTaskSessionsStream({ taskId });
  const run = useMemo(() => selectTargetTaskRun(taskRuns), [taskRuns]);
  const history = useConversationHistory({
    sessionScopeId: `${scope}:${taskId}`,
    taskId,
    runs: taskRuns,
    runsLoading,
    runsError,
    sessions,
    sessionsLoading,
    sessionsError,
    pendingSubmission: null,
  });
  return { taskRuns, runsLoading, run, ...history };
}
