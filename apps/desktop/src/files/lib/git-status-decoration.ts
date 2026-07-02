/**
 * Git status decorations for the file tree Explorer — presentation only.
 *
 * The decoration maps themselves (each changed file's status, rolled up to every
 * ancestor folder by a dominant-status priority) are computed in Rust and
 * delivered by the `decorated-tree` endpoint; see `crates/git/decorated_tree.rs`.
 * This module holds just the renderer-side concerns: the badge letter and tint
 * per status, the `Map` shape the tree components consume, and the converter
 * from the wire response.
 *
 * Paths are matched against `FileNode.relativePath`, which is repo-relative with
 * no leading slash — the same shape git reports.
 */
import type { DecorationStatus, GitDecorationMaps } from "@/lib/git-client";

export type { DecorationStatus };

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

/** Convert the backend's plain-object decoration maps into `Map`s for lookup. */
export function decorationsFromResponse(
  maps: GitDecorationMaps,
): GitDecorations {
  return {
    files: new Map(Object.entries(maps.files)),
    folders: new Map(Object.entries(maps.folders)),
  };
}
