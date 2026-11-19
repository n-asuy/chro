import type {
  ActionType,
  DisplayEntry,
  NormalizedEntry,
} from "@/session/types";

/**
 * The session list's hover preview of one session, in the mock's shape: the
 * last turn's request, its tool calls folded onto one line ("Ran · lighthouse,
 * Read · page.tsx"), and its latest reply.
 */
export interface TurnPreview {
  request: string | null;
  tools: string | null;
  reply: string | null;
}

function normalized(entry: DisplayEntry): NormalizedEntry | null {
  return entry.type === "NORMALIZED_ENTRY" ? entry.content : null;
}

/** The program a shell command runs, unwrapped from `sh -lc '…'`. */
function programOf(command: string): string {
  const wrapped = /^\S*\/?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(
    command.trim(),
  );
  const inner = (wrapped ? wrapped[2] : command).trim();
  return inner.split(/\s+/)[0] ?? inner;
}

function toolLabel(action: ActionType): string {
  switch (action.action) {
    case "command_run":
      return `Ran · ${programOf(action.command)}`;
    case "file_read":
      return `Read · ${action.path}`;
    case "file_edit":
      return `Edited · ${action.path}`;
    case "search":
      return `Searched · ${action.query}`;
    case "web_fetch":
      return `Fetched · ${action.url}`;
    case "tool":
      return action.tool_name;
    case "task_create":
      return action.description;
    case "plan_presentation":
      return "Plan";
    case "todo_management":
      return "Todos";
    case "other":
      return action.description;
  }
}

export function turnPreview(entries: readonly DisplayEntry[]): TurnPreview {
  let start = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && normalized(entry)?.entry_type.type === "user_message") {
      start = index;
      break;
    }
  }
  if (start < 0) return { request: null, tools: null, reply: null };

  const request = normalized(entries[start] as DisplayEntry)?.content ?? null;
  const tools: string[] = [];
  let reply: string | null = null;
  for (const entry of entries.slice(start + 1)) {
    const content = normalized(entry);
    if (!content) continue;
    const kind = content.entry_type;
    if (kind.type === "tool_use") tools.push(toolLabel(kind.action_type));
    else if (kind.type === "assistant_message" && content.content.trim()) {
      reply = content.content;
    }
  }
  return { request, tools: tools.length ? tools.join(", ") : null, reply };
}
