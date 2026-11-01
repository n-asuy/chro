import type { DiffContent } from "@/session/hooks/use-task-log-stream";

/**
 * What an open file is compared against for its change markers: the base
 * version from the diff the user sees for this scope (uncommitted changes in
 * a project, the session's changes in a worktree).
 */
export type ChangeBase =
  /** The diff has not loaded yet; show no markers rather than wrong ones. */
  | { kind: "unknown" }
  /** Not in the diff: the file on disk is its own base. */
  | { kind: "unchanged" }
  | { kind: "changed"; base: string }
  /** In the diff but without comparable text (binary, too large). */
  | { kind: "unavailable" };

const stripSlash = (path: string): string => path.replace(/^\/+/, "");

export const resolveChangeBase = ({
  path,
  diffs,
  isLoading,
}: {
  path: string;
  diffs: { path: string; diff: DiffContent }[];
  isLoading: boolean;
}): ChangeBase => {
  const target = stripSlash(path);
  const entry = diffs.find((d) => stripSlash(d.path) === target)?.diff;
  if (!entry) return isLoading ? { kind: "unknown" } : { kind: "unchanged" };
  if (entry.is_binary || entry.content_omitted) return { kind: "unavailable" };
  return { kind: "changed", base: entry.old_content ?? "" };
};

/** The text to mark changes against, given the file as last read from disk. */
export const changeBaseText = (
  base: ChangeBase,
  diskText: string | null,
): string | null => {
  switch (base.kind) {
    case "changed":
      return base.base;
    case "unchanged":
      return diskText;
    default:
      return null;
  }
};
