import type { DisplayEntry, TaskSessionRecord } from "../types";

export type TaskRunConversationState = {
  taskRunId: string;
  createdAt: string;
  entries: DisplayEntry[];
};

const isNormalizedUserMessage = (entry: DisplayEntry): boolean =>
  entry.type === "NORMALIZED_ENTRY" &&
  entry.content.entry_type.type === "user_message";

export function buildTaskSessionPromptMap(
  sessions: TaskSessionRecord[],
): Map<string, TaskSessionRecord> {
  const promptByRun = new Map<string, TaskSessionRecord>();

  for (const session of sessions) {
    if (!session.task_run_id) continue;
    if (!session.prompt?.trim()) continue;
    promptByRun.set(session.task_run_id, session);
  }

  return promptByRun;
}

export function filterConversationLogEntries(
  entries: DisplayEntry[],
  options?: { excludeUserMessages?: boolean },
): DisplayEntry[] {
  if (!options?.excludeUserMessages) {
    return entries;
  }

  return entries.filter((entry) => !isNormalizedUserMessage(entry));
}

export function createSyntheticUserMessageEntry(
  taskRunId: string,
  prompt: string,
  sessionId?: string,
): DisplayEntry {
  const id = sessionId
    ? `synthetic-user-${sessionId}`
    : `synthetic-user-${taskRunId}`;

  return {
    type: "NORMALIZED_ENTRY",
    key: `${taskRunId}:${id}`,
    content: {
      id,
      timestamp: null,
      entry_type: { type: "user_message" },
      content: prompt,
    },
  };
}

export function flattenConversationEntries(
  states: TaskRunConversationState[],
  sessions: TaskSessionRecord[],
): DisplayEntry[] {
  const promptByRun = buildTaskSessionPromptMap(sessions);

  return [...states]
    .sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    )
    .flatMap((state) => {
      const result: DisplayEntry[] = [];
      const session = promptByRun.get(state.taskRunId);
      const sessionPrompt = session?.prompt;

      if (sessionPrompt) {
        result.push(
          createSyntheticUserMessageEntry(
            state.taskRunId,
            sessionPrompt,
            session?.id,
          ),
        );
      }

      result.push(
        ...filterConversationLogEntries(state.entries, {
          excludeUserMessages: Boolean(sessionPrompt),
        }),
      );
      return result;
    });
}
