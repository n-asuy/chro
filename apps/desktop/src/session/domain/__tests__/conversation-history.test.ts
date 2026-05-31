import { describe, expect, it } from "vitest";
import type { DisplayEntry, TaskSessionRecord } from "../../types";
import {
  type TaskRunConversationState,
  buildTaskSessionPromptMap,
  createConversationFlattenCache,
  createLoadingEntry,
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

  it("applies prompt overrides for pending runs without sessions", () => {
    const states = [
      makeState("run-pending", "2025-01-01T00:00:00.000Z", [
        makeAssistantEntry("run-pending", "assistant-pending", "Pending reply"),
      ]),
    ];

    const flattened = flattenConversationEntries(states, [], {
      promptOverridesByRun: new Map([
        [
          "run-pending",
          {
            prompt: "Pending prompt",
          },
        ],
      ]),
    });

    expect(flattened).toEqual([
      createSyntheticUserMessageEntry("run-pending", "Pending prompt"),
      makeAssistantEntry("run-pending", "assistant-pending", "Pending reply"),
    ]);
  });

  it("appends loading indicators for specified runs", () => {
    const states = [
      makeState("run-1", "2025-01-01T00:00:00.000Z", [
        makeAssistantEntry("run-1"),
      ]),
    ];

    const flattened = flattenConversationEntries(states, [], {
      loadingRunIds: ["run-1"],
    });

    expect(flattened).toEqual([
      makeAssistantEntry("run-1"),
      createLoadingEntry("run-1"),
    ]);
  });
});

describe("createConversationFlattenCache", () => {
  it("produces the same output as the pure flatten on the first call", () => {
    const cache = createConversationFlattenCache();
    const sessions = [makeSession()];
    const states = [
      makeState("run-1", "2025-01-01T00:00:00.000Z", [
        makeUserMessageEntry("run-1"),
        makeAssistantEntry("run-1"),
      ]),
    ];

    expect(cache.flatten(states, sessions)).toEqual(
      flattenConversationEntries(states, sessions),
    );
  });

  it("returns the same array reference when nothing changed", () => {
    const cache = createConversationFlattenCache();
    const sessions = [makeSession()];
    const entries = [
      makeUserMessageEntry("run-1"),
      makeAssistantEntry("run-1"),
    ];
    const states = [makeState("run-1", "2025-01-01T00:00:00.000Z", entries)];

    const first = cache.flatten(states, sessions);
    const second = cache.flatten(states, sessions);

    expect(second).toBe(first);
  });

  it("only rebuilds the slice whose entries changed", () => {
    const cache = createConversationFlattenCache();
    const sessions = [
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
    ];

    const run1Entry = makeAssistantEntry("run-1", "assistant-run1", "Done");
    const run2Initial = makeAssistantEntry(
      "run-2",
      "assistant-run2-a",
      "Partial",
    );
    const run2Extended = makeAssistantEntry(
      "run-2",
      "assistant-run2-b",
      "More tokens",
    );

    const statesBefore = [
      makeState("run-1", "2025-01-01T00:00:00.000Z", [run1Entry]),
      makeState("run-2", "2025-01-02T00:00:00.000Z", [run2Initial]),
    ];
    const before = cache.flatten(statesBefore, sessions);

    const statesAfter = [
      // run-1 untouched (same `entries` reference)
      statesBefore[0],
      makeState("run-2", "2025-01-02T00:00:00.000Z", [
        run2Initial,
        run2Extended,
      ]),
    ];
    const after = cache.flatten(statesAfter, sessions);

    expect(after).not.toBe(before);
    // run-1 synthetic + assistant entries kept their identity
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    // run-2 synthetic entry kept its identity (prompt unchanged)
    expect(after[2]).toBe(before[2]);
    // run-2's first assistant entry kept its identity
    expect(after[3]).toBe(before[3]);
    // Only the newly-appended assistant entry is new
    expect(after[4]).toBe(run2Extended);
  });

  it("keeps the loading entry reference stable across patches", () => {
    const cache = createConversationFlattenCache();
    const sessions = [makeSession()];
    const initialEntries = [makeAssistantEntry("run-1", "a-1", "first")];

    const before = cache.flatten(
      [makeState("run-1", "2025-01-01T00:00:00.000Z", initialEntries)],
      sessions,
      { loadingRunIds: ["run-1"] },
    );

    const extendedEntries = [
      ...initialEntries,
      makeAssistantEntry("run-1", "a-2", "second"),
    ];
    const after = cache.flatten(
      [makeState("run-1", "2025-01-01T00:00:00.000Z", extendedEntries)],
      sessions,
      { loadingRunIds: ["run-1"] },
    );

    // Last element of both is the loading entry; reference must be reused
    expect(after[after.length - 1]).toBe(before[before.length - 1]);
  });

  it("invalidates a run when its prompt changes", () => {
    const cache = createConversationFlattenCache();
    const entries = [makeAssistantEntry("run-1", "a-1", "reply")];
    const state = makeState("run-1", "2025-01-01T00:00:00.000Z", entries);

    const first = cache.flatten(
      [state],
      [
        makeSession({
          id: "session-1",
          task_run_id: "run-1",
          prompt: "Old prompt",
        }),
      ],
    );

    const second = cache.flatten(
      [state],
      [
        makeSession({
          id: "session-1",
          task_run_id: "run-1",
          prompt: "New prompt",
        }),
      ],
    );

    expect(second[0]).not.toBe(first[0]);
    expect(second[0]).toEqual(
      createSyntheticUserMessageEntry("run-1", "New prompt", "session-1"),
    );
    // Assistant entry reference remains stable
    expect(second[1]).toBe(first[1]);
  });

  it("drops cached slices for runs no longer present", () => {
    const cache = createConversationFlattenCache();
    const sessions = [makeSession()];
    const state = makeState("run-1", "2025-01-01T00:00:00.000Z", [
      makeAssistantEntry("run-1"),
    ]);

    cache.flatten([state], sessions);
    const emptied = cache.flatten([], sessions);
    expect(emptied).toEqual([]);

    // Re-adding the same state must rebuild rather than serve stale cached entries
    const rebuilt = cache.flatten([state], sessions);
    expect(rebuilt).toEqual(flattenConversationEntries([state], sessions));
  });

  it("clear() empties the cache", () => {
    const cache = createConversationFlattenCache();
    const sessions = [makeSession()];
    const state = makeState("run-1", "2025-01-01T00:00:00.000Z", [
      makeAssistantEntry("run-1"),
    ]);

    const before = cache.flatten([state], sessions);
    cache.clear();
    const after = cache.flatten([state], sessions);

    expect(after).toEqual(before);
    expect(after).not.toBe(before);
  });
});
