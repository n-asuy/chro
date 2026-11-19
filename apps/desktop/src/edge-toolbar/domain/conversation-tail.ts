import type { DisplayEntry } from "@/session/types";

function isUserMessage(entry: DisplayEntry): boolean {
  return (
    entry.type === "NORMALIZED_ENTRY" &&
    entry.content.entry_type.type === "user_message"
  );
}

/**
 * The last `turns` turns of a conversation: everything from the `turns`-th
 * last user message on. A compact surface shows where the session is now,
 * not its history; the full conversation stays in the session window.
 */
export function conversationTail(
  entries: readonly DisplayEntry[],
  turns: number,
): DisplayEntry[] {
  let seen = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && isUserMessage(entry)) {
      seen += 1;
      if (seen === turns) return entries.slice(index);
    }
  }
  return [...entries];
}
