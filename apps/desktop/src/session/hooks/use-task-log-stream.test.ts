import { describe, expect, it } from "vitest";

import {
  type TaskRunPatchState,
  applyTaskRunPatchOperations,
} from "./use-task-log-stream";

describe("applyTaskRunPatchOperations", () => {
  it("upserts out-of-range cumulative replaces instead of duplicating entries", () => {
    let state: TaskRunPatchState = {
      entries: [],
      document: {
        diffs: {},
        approvals: {},
      },
    };

    for (const content of ["partial", "partial update", "final response"]) {
      state = applyTaskRunPatchOperations(state, [
        {
          op: "replace",
          path: "/entries/400",
          value: {
            type: "NORMALIZED_ENTRY",
            content: {
              type: { type: "assistant_message" },
              content,
            },
          },
        },
      ]);
    }

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      type: "NORMALIZED_ENTRY",
      key: "task-run:stream-entry:400",
      content: { content: "final response" },
    });
  });

  it("replays history against an empty state without retaining stale entries", () => {
    const staleState = {
      entries: [
        {
          type: "STDOUT" as const,
          content: "stale log",
          key: "stale-key",
        },
      ],
      document: {
        diffs: {
          "stale.ts": {
            change: "modified" as const,
          },
        },
        approvals: {
          stale: {
            id: "stale",
            task_run_id: "task-run",
            tool_name: "old-tool",
            tool_input: {},
            created_at: "2025-01-01T00:00:00.000Z",
            timeout_at: "2025-01-01T00:01:00.000Z",
            status: { status: "pending" as const },
          },
        },
      },
    };

    const historyReplayOps = [
      {
        op: "add" as const,
        path: "/entries/0",
        value: {
          type: "STDOUT" as const,
          content: "fresh log",
        },
      },
      {
        op: "add" as const,
        path: "/diffs/fresh.ts",
        value: {
          change: "added" as const,
        },
      },
      {
        op: "add" as const,
        path: "/approvals/fresh",
        value: {
          id: "fresh",
          task_run_id: "task-run",
          tool_name: "new-tool",
          tool_input: {},
          created_at: "2025-01-01T00:00:00.000Z",
          timeout_at: "2025-01-01T00:01:00.000Z",
          status: { status: "approved" as const },
        },
      },
    ];

    const replayed = applyTaskRunPatchOperations(
      {
        entries: [],
        document: {
          diffs: {},
          approvals: {},
        },
      },
      historyReplayOps,
    );

    expect(staleState.entries).toHaveLength(1);
    expect(replayed.entries).toHaveLength(1);
    expect(replayed.entries[0]).toMatchObject({
      type: "STDOUT",
      content: "fresh log",
    });
    expect(replayed.document.diffs).toEqual({
      "fresh.ts": {
        change: "added",
        old_path: undefined,
        new_path: undefined,
        old_content: undefined,
        new_content: undefined,
        content_omitted: false,
        additions: undefined,
        deletions: undefined,
        content: undefined,
        kind: undefined,
      },
    });
    expect(Object.keys(replayed.document.approvals)).toEqual(["fresh"]);
    expect(replayed.document.approvals.stale).toBeUndefined();
    expect(replayed.document.diffs["stale.ts"]).toBeUndefined();
  });
});
