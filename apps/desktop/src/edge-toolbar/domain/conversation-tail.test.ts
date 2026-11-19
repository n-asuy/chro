import type { DisplayEntry } from "@/session/types";
import { describe, expect, it } from "vitest";
import { conversationTail } from "./conversation-tail";

function entry(key: string, kind: "user_message" | "assistant_message") {
  return {
    type: "NORMALIZED_ENTRY",
    key,
    content: { entry_type: { type: kind }, content: key },
  } as unknown as DisplayEntry;
}

const user = (key: string) => entry(key, "user_message");
const reply = (key: string) => entry(key, "assistant_message");

describe("conversationTail", () => {
  it("keeps the last N turns, each starting at its user message", () => {
    const entries = [
      user("u1"),
      reply("a1"),
      user("u2"),
      reply("a2"),
      user("u3"),
      reply("a3"),
    ];

    const tail = conversationTail(entries, 2);

    expect(tail.map((e) => e.key)).toEqual(["u2", "a2", "u3", "a3"]);
  });

  it("keeps everything when there are fewer turns than asked for", () => {
    const entries = [reply("setup"), user("u1"), reply("a1")];

    expect(conversationTail(entries, 3).map((e) => e.key)).toEqual([
      "setup",
      "u1",
      "a1",
    ]);
  });

  it("keeps output that has no user message yet", () => {
    const entries: DisplayEntry[] = [
      { type: "STDOUT", content: "booting", key: "o1" },
    ];

    expect(conversationTail(entries, 1)).toEqual(entries);
  });
});
