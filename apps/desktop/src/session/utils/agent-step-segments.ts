import type { DisplayEntry, NormalizedEntry } from "../types";

export type NormalizedDisplayEntry = Extract<
  DisplayEntry,
  { type: "NORMALIZED_ENTRY" }
>;

/**
 * A run of consecutive agent "working" entries (thinking, tool calls, the
 * trailing loading sentinel) rendered as one collapsible thinking-steps
 * timeline. `live` means the agent is still working inside this run — either
 * it ends with a loading entry or a tool call is waiting for approval — so
 * the header shimmers. `awaitingApproval` additionally forces the timeline
 * open so the approval prompt stays reachable. `label` is the header text:
 * reasoning prose when available, otherwise a tool summary (null when the
 * run has nothing to show — callers fall back to a static label).
 */
export type ThinkingStepsSegment = {
  type: "THINKING_STEPS";
  entries: NormalizedDisplayEntry[];
  live: boolean;
  awaitingApproval: boolean;
  label: string | null;
  key: string;
};

export type ConversationSegment =
  | { type: "ENTRY"; entry: DisplayEntry; key: string }
  | ThinkingStepsSegment;

const isEmptyThinking = (entry: NormalizedDisplayEntry): boolean =>
  entry.content.entry_type.type === "thinking" &&
  entry.content.content.trim().length === 0;

const isStepEntry = (entry: DisplayEntry): entry is NormalizedDisplayEntry => {
  if (entry.type !== "NORMALIZED_ENTRY") return false;
  const type = entry.content.entry_type.type;
  return type === "thinking" || type === "tool_use" || type === "loading";
};

const isLoadingEntry = (entry: NormalizedDisplayEntry): boolean =>
  entry.content.entry_type.type === "loading";

const isPendingApproval = (entry: NormalizedDisplayEntry): boolean =>
  entry.content.entry_type.type === "tool_use" &&
  entry.content.entry_type.status.status === "pending_approval";

/**
 * Splits a turn's entries into passthrough entries and thinking-steps runs.
 * Empty thinking entries are dropped; everything that is not a working entry
 * (assistant messages, errors, raw output, …) breaks the current run.
 */
export function segmentConversationEntries(
  entries: DisplayEntry[],
): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  let run: NormalizedDisplayEntry[] = [];
  // The latest reasoning prose seen in this turn. Tool-only runs (the agent
  // narrated in an assistant message, then ran tools) inherit it so their
  // header stays prose instead of a raw command.
  let carriedThinkingSummary: string | null = null;

  const flushRun = () => {
    if (run.length === 0) return;
    const last = run[run.length - 1]!;
    const awaitingApproval = run.some(isPendingApproval);

    let thinkingSummary: string | null = null;
    let toolSummary: string | null = null;
    for (let i = run.length - 1; i >= 0; i--) {
      const entry = run[i]!.content;
      const summary = stepEntrySummary(entry);
      if (!summary) continue;
      if (entry.entry_type.type === "thinking") {
        thinkingSummary = summary;
        break;
      }
      toolSummary ??= summary;
    }
    if (thinkingSummary) carriedThinkingSummary = thinkingSummary;

    segments.push({
      type: "THINKING_STEPS",
      entries: run,
      live: isLoadingEntry(last) || awaitingApproval,
      awaitingApproval,
      label: thinkingSummary ?? carriedThinkingSummary ?? toolSummary,
      key: `steps:${run[0]!.key}`,
    });
    run = [];
  };

  for (const entry of entries) {
    if (isStepEntry(entry)) {
      if (!isEmptyThinking(entry)) {
        run.push(entry);
      }
      continue;
    }
    flushRun();
    segments.push({ type: "ENTRY", entry, key: entry.key });
  }

  flushRun();
  return segments;
}

const firstNonEmptyLine = (text: string): string | null => {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
};

/** Strip the markdown markers that commonly lead a thinking line so the
 * header reads as plain text (emphasis, headings, list bullets, quotes). */
const stripMarkdownMarkers = (line: string): string =>
  line
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[#>\-*\s]+/, "")
    .trim();

/**
 * A one-line label for a working entry, used as the timeline header so it
 * shows what the agent is doing (live) or last did (completed) instead of a
 * static "Thinking". Returns null when the entry has nothing to show.
 */
export function stepEntrySummary(entry: NormalizedEntry): string | null {
  const entryType = entry.entry_type;

  if (entryType.type === "tool_use") {
    const action = entryType.action_type;
    switch (action.action) {
      case "command_run": {
        const command = firstNonEmptyLine(action.command ?? "");
        return command ? `$ ${command}` : entryType.tool_name || null;
      }
      case "file_read":
      case "file_edit":
        return action.path || entryType.tool_name || null;
      case "search":
        return action.query || entryType.tool_name || null;
      case "web_fetch":
        return action.url || entryType.tool_name || null;
      default:
        return entryType.tool_name || null;
    }
  }

  const line = firstNonEmptyLine(entry.content);
  if (!line) return null;
  if (entryType.type === "thinking") {
    const stripped = stripMarkdownMarkers(line);
    return stripped.length > 0 ? stripped : null;
  }
  // loading entries carry an optional progress message
  return line;
}

