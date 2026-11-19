import type { ActionType, DisplayEntry } from "@/session/types";
import { describe, expect, it } from "vitest";
import { turnPreview } from "./turn-preview";

let n = 0;
function entry(
  entry_type: Extract<
    DisplayEntry,
    { type: "NORMALIZED_ENTRY" }
  >["content"]["entry_type"],
  content = "",
): DisplayEntry {
  n += 1;
  return {
    type: "NORMALIZED_ENTRY",
    key: `k${n}`,
    content: { id: `e${n}`, entry_type, content },
  };
}
const user = (text: string) => entry({ type: "user_message" }, text);
const reply = (text: string) => entry({ type: "assistant_message" }, text);
const tool = (action_type: ActionType, tool_name = "x") =>
  entry({
    type: "tool_use",
    tool_name,
    action_type,
    status: { status: "success" },
  });

describe("turnPreview", () => {
  it("takes the last turn's request, its tool calls on one line, and its latest reply", () => {
    const preview = turnPreview([
      user("old request"),
      reply("old reply"),
      user("The checkout page takes 4 seconds to load. Find out why."),
      tool({
        action: "command_run",
        command: "/bin/zsh -lc 'lighthouse http://localhost:3000'",
      }),
      tool({ action: "file_read", path: "app/checkout/page.tsx" }),
      reply("Looking at the cart query."),
      reply("Two worktrees are running their benchmarks."),
    ]);
    expect(preview).toEqual({
      request: "The checkout page takes 4 seconds to load. Find out why.",
      tools: "Ran · lighthouse, Read · app/checkout/page.tsx",
      reply: "Two worktrees are running their benchmarks.",
    });
  });

  it("names every kind of tool call by what it did", () => {
    const preview = turnPreview([
      user("go"),
      tool({ action: "file_edit", path: "a.ts" }),
      tool({ action: "search", query: "useCart" }),
      tool({ action: "web_fetch", url: "https://example.com" }),
      tool(
        { action: "tool", tool_name: "mcp__notes__append" },
        "mcp__notes__append",
      ),
      tool({ action: "other", description: "Planned" }),
      tool({ action: "command_run", command: "ls -1 | wc -l" }),
    ]);
    expect(preview.tools).toBe(
      "Edited · a.ts, Searched · useCart, Fetched · https://example.com, mcp__notes__append, Planned, Ran · ls",
    );
  });

  it("is empty for a session with no conversation yet", () => {
    expect(turnPreview([])).toEqual({
      request: null,
      tools: null,
      reply: null,
    });
  });

  it("keeps a turn that has not replied yet", () => {
    expect(
      turnPreview([user("go"), tool({ action: "file_read", path: "x" })]),
    ).toEqual({
      request: "go",
      tools: "Read · x",
      reply: null,
    });
  });
});
