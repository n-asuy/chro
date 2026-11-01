import type { StoredTask } from "../types";

/** The one fact a session row shows under its title. */
export type SessionSubline = {
  kind: "note" | "summary" | "forked" | "delegated" | "project";
  text: string;
} | null;

/**
 * One sub-line, one fact. While a turn runs, the agent's own note wins: it
 * says what is happening now. Otherwise the run outcome wins: it says what the
 * session actually did, which no other row element carries; a note set before
 * any run finished comes next. Provenance follows (a forked row is only
 * legible if you can see what it continues; also the only signal before the
 * first run), then the project name for pinned rows.
 */
export function sessionSubline(
  task: StoredTask,
  opts: {
    isRunning: boolean;
    showProject: boolean;
    projectName: string | null;
  },
): SessionSubline {
  if (opts.isRunning && task.note) return { kind: "note", text: task.note };
  if (task.last_summary) return { kind: "summary", text: task.last_summary };
  if (task.note) return { kind: "note", text: task.note };
  if (task.forked_from_title) {
    return { kind: "forked", text: task.forked_from_title };
  }
  if (task.delegated_from_title) {
    return { kind: "delegated", text: task.delegated_from_title };
  }
  if (opts.showProject && opts.projectName) {
    return { kind: "project", text: opts.projectName };
  }
  return null;
}
