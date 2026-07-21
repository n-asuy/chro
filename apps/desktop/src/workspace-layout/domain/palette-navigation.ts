import { deriveSessionState } from "@/session/domain/session-grouping";
import { deriveTaskStatusDot } from "@/session/domain/task-read-state";
import type { StoredTask } from "@/session/types";

/**
 * Section-building logic for the quick-switcher palette ("where do you want
 * to go?"). Pure and i18n-agnostic: callers pass already-labelled commands
 * and resolve headings/icons themselves.
 *
 * Two modes, keyed on the (trimmed) query:
 * - Browsing (empty query): likely destinations — commands, then sessions
 *   that need the user (blocked on input, or failed and not yet seen), then
 *   a short recency list.
 * - Searching: ranked matches — commands, projects, sessions — where a title
 *   prefix beats a title substring beats a project-name-only match.
 */

/** Why a session row carries a marker: blocked on the user, or unseen failure. */
export type SessionFlag = "needs_input" | "failed" | null;

export type PaletteItem =
  | { kind: "command"; commandId: string }
  | { kind: "session"; task: StoredTask; flag: SessionFlag }
  | { kind: "project"; projectId: string };

export type PaletteSectionId =
  | "commands"
  | "attention"
  | "recent"
  | "projects"
  | "sessions";

export interface PaletteSection {
  id: PaletteSectionId;
  items: PaletteItem[];
}

export interface BuildPaletteSectionsInput {
  query: string;
  commands: { id: string; label: string }[];
  /** Non-archived sessions, most-recent-first. */
  sessions: StoredTask[];
  /** Selectable project destinations (the hidden General project excluded). */
  projects: { id: string; name: string }[];
  /** Resolves a session's `project_id` to a display name for matching. */
  projectNameOf: (projectId: string) => string | null;
  /** Read watermark per task; feeds the unseen-failure flag. */
  lastViewedAtOf: (taskId: string) => string | null | undefined;
}

export const ATTENTION_MAX = 5;
export const RECENT_MAX = 15;
export const PROJECT_RESULTS_MAX = 8;
export const SESSION_RESULTS_MAX = 50;

const matches = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().includes(needle);

const prefixed = (haystack: string, needle: string): boolean =>
  haystack.toLowerCase().startsWith(needle);

function deriveFlag(
  task: StoredTask,
  lastViewedAt: string | null | undefined,
): SessionFlag {
  if (deriveSessionState(task) === "needs_input") return "needs_input";
  if (deriveTaskStatusDot(task, lastViewedAt) === "failed") return "failed";
  return null;
}

export function buildPaletteSections(
  input: BuildPaletteSectionsInput,
): PaletteSection[] {
  const query = input.query.trim().toLowerCase();
  const sections = query ? searchSections(input, query) : browseSections(input);
  return sections.filter((section) => section.items.length > 0);
}

function sessionItem(
  input: BuildPaletteSectionsInput,
  task: StoredTask,
): PaletteItem {
  return {
    kind: "session",
    task,
    flag: deriveFlag(task, input.lastViewedAtOf(task.id)),
  };
}

function browseSections(input: BuildPaletteSectionsInput): PaletteSection[] {
  const commands: PaletteItem[] = input.commands.map((command) => ({
    kind: "command",
    commandId: command.id,
  }));

  // Attention = sessions waiting on the user, blocked ones first. Both lists
  // preserve the input's recency order.
  const blocked: PaletteItem[] = [];
  const unseenFailures: PaletteItem[] = [];
  for (const task of input.sessions) {
    const item = sessionItem(input, task);
    if (item.kind !== "session" || !item.flag) continue;
    (item.flag === "needs_input" ? blocked : unseenFailures).push(item);
  }
  const attention = [...blocked, ...unseenFailures].slice(0, ATTENTION_MAX);
  const attentionIds = new Set(
    attention.flatMap((item) =>
      item.kind === "session" ? [item.task.id] : [],
    ),
  );

  const recent: PaletteItem[] = [];
  for (const task of input.sessions) {
    if (attentionIds.has(task.id)) continue;
    recent.push(sessionItem(input, task));
    if (recent.length >= RECENT_MAX) break;
  }

  return [
    { id: "commands", items: commands },
    { id: "attention", items: attention },
    { id: "recent", items: recent },
  ];
}

function searchSections(
  input: BuildPaletteSectionsInput,
  query: string,
): PaletteSection[] {
  const commands: PaletteItem[] = input.commands
    .filter((command) => matches(command.label, query))
    .map((command) => ({ kind: "command", commandId: command.id }));

  const projects = rankTop(
    input.projects,
    (project) => {
      if (prefixed(project.name, query)) return 2;
      if (matches(project.name, query)) return 1;
      return 0;
    },
    PROJECT_RESULTS_MAX,
  ).map((project): PaletteItem => ({ kind: "project", projectId: project.id }));

  const sessions = rankTop(
    input.sessions,
    (task) => {
      const title = task.title ?? "";
      if (prefixed(title, query)) return 3;
      if (matches(title, query)) return 2;
      const project = input.projectNameOf(task.project_id);
      if (project && matches(project, query)) return 1;
      return 0;
    },
    SESSION_RESULTS_MAX,
  ).map((task) => sessionItem(input, task));

  return [
    { id: "commands", items: commands },
    { id: "projects", items: projects },
    { id: "sessions", items: sessions },
  ];
}

/**
 * Score, drop non-matches, and keep the top `limit` by score. The sort is
 * stable, so equal scores fall back to the input (recency) order.
 */
function rankTop<T>(
  items: T[],
  score: (item: T) => number,
  limit: number,
): T[] {
  return items
    .map((item, index) => ({ item, score: score(item), index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}
