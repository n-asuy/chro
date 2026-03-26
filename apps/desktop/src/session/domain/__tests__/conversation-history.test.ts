import { describe, expect, it } from "vitest";
import type { DisplayEntry, TaskSessionRecord } from "../../types";
import {
  type TaskRunConversationState,
  buildTaskSessionPromptMap,
  createSyntheticUserMessageEntry,
  filterConversationLogEntries,
  flattenConversationEntries,
} from "../conversation-history";

const makeSession = (
  overrides?: Partial<TaskSessionRecord>,
): TaskSessionRecord => ({
  id: "session-1",
  task_id: "task-1",
  task_run_id: "run-1",
  agent_profile_id: "agent-1",
  external_session_id: null,
  prompt: "Follow up prompt",
  summary: null,
  handoff_from_session_id: null,
  worktree_commit: null,
  state_snapshot: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  ...overrides,
});

const makeUserMessageEntry = (
  runId: string,
  content = "Prompt from logs",
): DisplayEntry => ({
  type: "NORMALIZED_ENTRY",
  key: `${runId}:user-1`,
  content: {
    id: "user-1",
    timestamp: null,
    entry_type: { type: "user_message" },
    content,
  },
});

const makeAssistantEntry = (
  runId: string,
  id = "assistant-1",
  content = "Assistant reply",
): DisplayEntry => ({
  type: "NORMALIZED_ENTRY",
  key: `${runId}:${id}`,
  content: {
    id,
    timestamp: null,
    entry_type: { type: "assistant_message" },
    content,
  },
});

const makeState = (
  taskRunId: string,
  createdAt: string,
  entries: DisplayEntry[],
): TaskRunConversationState => ({
  taskRunId,
  createdAt,
  entries,
});

describe("buildTaskSessionPromptMap", () => {
  it("indexes sessions by run id when prompt exists", () => {
    const promptMap = buildTaskSessionPromptMap([
      makeSession(),
      makeSession({
        id: "session-2",
        task_run_id: "run-2",
        prompt: "Second prompt",
      }),
      makeSession({
        id: "session-3",
        task_run_id: "run-3",
        prompt: "   ",
      }),
      makeSession({
        id: "session-4",
        task_run_id: null,
      }),
    ]);

    expect(promptMap.get("run-1")?.id).toBe("session-1");
    expect(promptMap.get("run-2")?.id).toBe("session-2");
    expect(promptMap.has("run-3")).toBe(false);
    expect(promptMap.has("run-4")).toBe(false);
  });
});

describe("filterConversationLogEntries", () => {
  it("removes log user messages only when requested", () => {
    const entries = [
      makeUserMessageEntry("run-1"),
      makeAssistantEntry("run-1"),
    ];

    expect(
      filterConversationLogEntries(entries, { excludeUserMessages: true }),
    ).toEqual([makeAssistantEntry("run-1")]);
    expect(filterConversationLogEntries(entries)).toEqual(entries);
  });
});

describe("createSyntheticUserMessageEntry", () => {
  it("creates a stable synthetic entry keyed by session id", () => {
    expect(
      createSyntheticUserMessageEntry("run-1", "Follow up prompt", "session-9"),
    ).toEqual({
      type: "NORMALIZED_ENTRY",
      key: "run-1:synthetic-user-session-9",
      content: {
        id: "synthetic-user-session-9",
        timestamp: null,
        entry_type: { type: "user_message" },
        content: "Follow up prompt",
      },
    });
  });
});

describe("flattenConversationEntries", () => {
  it("prepends a synthetic user message and removes duplicate log user messages", () => {
    const states = [
      makeState("run-1", "2025-01-01T00:00:00.000Z", [
        makeUserMessageEntry("run-1"),
        makeAssistantEntry("run-1"),
      ]),
    ];

    const flattened = flattenConversationEntries(states, [makeSession()]);

    expect(flattened).toEqual([
      createSyntheticUserMessageEntry("run-1", "Follow up prompt", "session-1"),
      makeAssistantEntry("run-1"),
    ]);
  });

  it("preserves log user messages when no session prompt exists", () => {
    const states = [
      makeState("run-2", "2025-01-01T00:00:00.000Z", [
        makeUserMessageEntry("run-2"),
        makeAssistantEntry("run-2"),
      ]),
    ];

    const flattened = flattenConversationEntries(states, [
      makeSession({
        id: "session-2",
        task_run_id: "run-2",
        prompt: null,
      }),
    ]);

    expect(flattened).toEqual([
      makeUserMessageEntry("run-2"),
      makeAssistantEntry("run-2"),
    ]);
  });

  it("orders runs by createdAt before flattening", () => {
    const states = [
      makeState("run-2", "2025-01-02T00:00:00.000Z", [
        makeAssistantEntry("run-2", "assistant-2", "Second reply"),
      ]),
      makeState("run-1", "2025-01-01T00:00:00.000Z", [
        makeAssistantEntry("run-1", "assistant-1", "First reply"),
      ]),
    ];

    const flattened = flattenConversationEntries(states, [
      makeSession({
        id: "session-1",
        task_run_id: "run-1",
        prompt: "First prompt",
      }),
      makeSession({
        id: "session-2",
        task_run_id: "run-2",
        prompt: "Second prompt",
      }),
    ]);

    expect(flattened.map((entry) => entry.key)).toEqual([
      "run-1:synthetic-user-session-1",
      "run-1:assistant-1",
      "run-2:synthetic-user-session-2",
      "run-2:assistant-2",
    ]);
  });
});
