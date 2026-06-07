/**
 * Git status decorations for the file tree, ported from Orca's Explorer.
 *
 * Changed files are tinted and badged with a one-letter status (M/A/D/R/C/U),
 * and the status rolls up to every ancestor folder using a dominant-status
 * priority so a collapsed folder still signals "something changed inside me".
 *
 * Paths are matched against `FileNode.relativePath`, which is repo-relative
 * with no leading slash — the same shape git reports.
 */
import type { FileChangeStatus, GitStatus } from "@/lib/git-client";

export type DecorationStatus = FileChangeStatus | "untracked";

/** Higher wins when several statuses collapse onto one folder. */
const STATUS_PRIORITY: Record<DecorationStatus, number> = {
  deleted: 6,
  modified: 5,
  typechange: 4,
  added: 3,
  untracked: 3,
  renamed: 2,
  copied: 1,
};

export const STATUS_LABEL: Record<DecorationStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
};

/** Tailwind text color per status, matching the source-control panel. */
export const STATUS_TEXT_CLASS: Record<DecorationStatus, string> = {
  added: "text-green-500",
  untracked: "text-green-500",
  modified: "text-yellow-500",
  typechange: "text-yellow-500",
  deleted: "text-red-500",
  renamed: "text-blue-500",
  copied: "text-blue-500",
};

const dominant = (
  a: DecorationStatus,
  b: DecorationStatus,
): DecorationStatus => (STATUS_PRIORITY[a] >= STATUS_PRIORITY[b] ? a : b);

export interface GitDecorations {
  /** relativePath → status, for files. */
  files: Map<string, DecorationStatus>;
  /** ancestor folder relativePath → dominant status of its changed descendants. */
  folders: Map<string, DecorationStatus>;
}

export const EMPTY_DECORATIONS: GitDecorations = {
  files: new Map(),
  folders: new Map(),
};

/** A changed path paired with its status — the common input for decorations. */
export interface DecorationEntry {
  /** Repo-relative path (leading slashes and backslashes are normalized). */
  path: string;
  status: DecorationStatus;
}

/**
 * Build file- and folder-level decoration maps from a flat list of changed
 * paths. Each file maps to its status; the status also rolls up to every
 * ancestor folder. When a path or folder carries several statuses the dominant
 * one wins.
 */
export function buildDecorationsFromEntries(
  entries: DecorationEntry[],
): GitDecorations {
  const files = new Map<string, DecorationStatus>();
  const folders = new Map<string, DecorationStatus>();

  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) continue;
    const next = entry.status;

    const existingFile = files.get(path);
    files.set(path, existingFile ? dominant(existingFile, next) : next);

    const segments = path.split("/");
    let current = "";
    for (let i = 0; i < segments.length - 1; i++) {
      current = current ? `${current}/${segments[i]}` : segments[i]!;
      const existingFolder = folders.get(current);
      folders.set(
        current,
        existingFolder ? dominant(existingFolder, next) : next,
      );
    }
  }

  return { files, folders };
}

/**
 * Build decorations from a git status snapshot (project working tree). Staged,
 * unstaged, and untracked entries are all folded in.
 */
export function buildGitDecorations(status: GitStatus | null): GitDecorations {
  if (!status) return EMPTY_DECORATIONS;

  const entries: DecorationEntry[] = [
    ...status.staged.map((f) => ({ path: f.path, status: f.status })),
    ...status.modified.map((f) => ({ path: f.path, status: f.status })),
    ...status.untracked.map((path) => ({
      path,
      status: "untracked" as const,
    })),
  ];

  return buildDecorationsFromEntries(entries);
}
