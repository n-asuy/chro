import { describe, expect, it } from "vitest";
import type {
  DisplayEntry,
  NormalizedEntryType,
  ToolStatus,
} from "../../types";
import {
  segmentConversationEntries,
  stepEntrySummary,
} from "../agent-step-segments";

let entryCounter = 0;

const normalized = (
  entry_type: NormalizedEntryType,
  content = "",
): DisplayEntry => {
  entryCounter += 1;
  const id = `entry-${entryCounter}`;
  return {
    type: "NORMALIZED_ENTRY",
    key: id,
    content: { id, entry_type, content },
  };
};

const toolUse = (status: ToolStatus = { status: "success" }): DisplayEntry =>
  normalized(
    {
      type: "tool_use",
      tool_name: "Bash",
      action_type: { action: "command_run", command: "ls" },
      status,
    },
    "[Tool] ls",
  );

const thinking = (content = "Reasoning about the task"): DisplayEntry =>
  normalized({ type: "thinking" }, content);

const assistant = (content = "Done."): DisplayEntry =>
  normalized({ type: "assistant_message" }, content);

const loading = (): DisplayEntry => normalized({ type: "loading" });

const stdout = (): DisplayEntry => {
  entryCounter += 1;
  return { type: "STDOUT", content: "raw", key: `stdout-${entryCounter}` };
};

describe("segmentConversationEntries", () => {
  it("groups consecutive thinking and tool_use entries into one steps segment", () => {
    const entries = [thinking(), toolUse(), toolUse()];
    const segments = segmentConversationEntries(entries);

    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    expect(segment.type).toBe("THINKING_STEPS");
    if (segment.type !== "THINKING_STEPS") return;
    expect(segment.entries).toHaveLength(3);
    expect(segment.live).toBe(false);
    expect(segment.key).toBe(`steps:${entries[0]!.key}`);
  });

  it("splits step runs on assistant messages", () => {
    const segments = segmentConversationEntries([
      toolUse(),
      assistant(),
      toolUse(),
    ]);

    expect(segments.map((s) => s.type)).toEqual([
      "THINKING_STEPS",
      "ENTRY",
      "THINKING_STEPS",
    ]);
  });

  it("splits step runs on raw stdout/stderr output", () => {
    const segments = segmentConversationEntries([
      toolUse(),
      stdout(),
      toolUse(),
    ]);

    expect(segments.map((s) => s.type)).toEqual([
      "THINKING_STEPS",
      "ENTRY",
      "THINKING_STEPS",
    ]);
  });

  it("marks a run live when it ends with a loading entry", () => {
    const segments = segmentConversationEntries([thinking(), loading()]);

    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    if (segment.type !== "THINKING_STEPS") throw new Error("expected steps");
    expect(segment.live).toBe(true);
    expect(segment.entries).toHaveLength(2);
  });

  it("marks a run live and awaiting approval while a tool waits for approval", () => {
    const segments = segmentConversationEntries([
      toolUse({
        status: "pending_approval",
        approval_id: "a1",
        requested_at: "2026-01-01T00:00:00Z",
        timeout_at: "2026-01-01T00:05:00Z",
      }),
    ]);

    const segment = segments[0]!;
    if (segment.type !== "THINKING_STEPS") throw new Error("expected steps");
    expect(segment.live).toBe(true);
    expect(segment.awaitingApproval).toBe(true);
  });

  it("does not flag approval for a plain live run", () => {
    const segments = segmentConversationEntries([thinking(), loading()]);

    const segment = segments[0]!;
    if (segment.type !== "THINKING_STEPS") throw new Error("expected steps");
    expect(segment.awaitingApproval).toBe(false);
  });

  it("treats a lone loading entry as a live steps segment", () => {
    const segments = segmentConversationEntries([loading()]);

    expect(segments).toHaveLength(1);
    const segment = segments[0]!;
    if (segment.type !== "THINKING_STEPS") throw new Error("expected steps");
    expect(segment.live).toBe(true);
  });

  it("drops empty thinking entries", () => {
    const segments = segmentConversationEntries([
      thinking("  \n "),
      assistant(),
    ]);

    expect(segments.map((s) => s.type)).toEqual(["ENTRY"]);
  });

  it("passes non-step entries through with their own keys", () => {
    const message = assistant();
    const segments = segmentConversationEntries([message]);

    expect(segments).toEqual([
      { type: "ENTRY", entry: message, key: message.key },
    ]);
  });
});

describe("stepEntrySummary", () => {
  const contentOf = (entry: DisplayEntry) =>
    entry.type === "NORMALIZED_ENTRY" ? entry.content : null;

  it("summarizes a command run as a shell line", () => {
    const entry = contentOf(toolUse())!;
    expect(stepEntrySummary(entry)).toBe("$ ls");
  });

  it("summarizes file actions with their path", () => {
    const entry = contentOf(
      normalized(
        {
          type: "tool_use",
          tool_name: "Read",
          action_type: { action: "file_read", path: "src/main.rs" },
          status: { status: "success" },
        },
        "",
      ),
    )!;
    expect(stepEntrySummary(entry)).toBe("src/main.rs");
  });

  it("falls back to the tool name for other tools", () => {
    const entry = contentOf(
      normalized(
        {
          type: "tool_use",
          tool_name: "WebSearch",
          action_type: { action: "tool", tool_name: "WebSearch" },
          status: { status: "success" },
        },
        "",
      ),
    )!;
    expect(stepEntrySummary(entry)).toBe("WebSearch");
  });

  it("uses the first line of thinking content, stripped of markdown markers", () => {
    const entry = contentOf(
      thinking("**Checking** the build setup\nmore detail"),
    )!;
    expect(stepEntrySummary(entry)).toBe("Checking the build setup");
  });

  it("returns null for loading entries without content", () => {
    const entry = contentOf(loading())!;
    expect(stepEntrySummary(entry)).toBeNull();
  });
});

describe("segment labels", () => {
  const labelsOf = (entries: DisplayEntry[]) =>
    segmentConversationEntries(entries)
      .filter((s) => s.type === "THINKING_STEPS")
      .map((s) => (s.type === "THINKING_STEPS" ? s.label : null));

  it("prefers the latest thinking prose over later tool calls", () => {
    expect(
      labelsOf([
        thinking("Old idea"),
        thinking("Inspecting the build output"),
        toolUse(),
        toolUse(),
      ]),
    ).toEqual(["Inspecting the build output"]);
  });

  it("carries the previous reasoning into tool-only runs of the same turn", () => {
    expect(
      labelsOf([
        thinking("Verifying the dev server"),
        assistant("Let me check."),
        toolUse(),
      ]),
    ).toEqual(["Verifying the dev server", "Verifying the dev server"]);
  });

  it("falls back to the tool summary when the turn has no reasoning", () => {
    expect(labelsOf([toolUse(), loading()])).toEqual(["$ ls"]);
  });

  it("labels a lone loading run as null for the caller's fallback", () => {
    expect(labelsOf([loading()])).toEqual([null]);
  });
});
