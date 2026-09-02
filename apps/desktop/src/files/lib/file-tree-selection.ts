/**
 * Return the contiguous visible range between an anchor and a target.
 * Falls back to the target when the anchor is no longer visible (for example,
 * after its parent folder was collapsed).
 */
export function getVisibleRangePaths(
  visiblePaths: readonly string[],
  anchorPath: string | null,
  targetPath: string,
): string[] {
  const targetIndex = visiblePaths.indexOf(targetPath);
  if (targetIndex < 0) return [targetPath];

  const anchorIndex = anchorPath ? visiblePaths.indexOf(anchorPath) : -1;
  if (anchorIndex < 0) return [targetPath];

  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visiblePaths.slice(start, end + 1);
}

/**
 * Remove duplicates and descendants whose ancestor is already selected.
 * File operations must only receive the top-level selection, otherwise an
 * operation on a folder followed by the same operation on one of its children
 * can fail or act on the wrong path.
 */
export function normalizeFileOperationPaths(
  paths: readonly string[],
): string[] {
  const unique = Array.from(new Set(paths.filter(Boolean)));
  return unique.filter(
    (path) =>
      !unique.some(
        (candidate) =>
          candidate !== path &&
          (candidate === "/"
            ? path.startsWith("/")
            : path.startsWith(`${candidate}/`)),
      ),
  );
}

/** Keep a multi-selection when its member is right-clicked; otherwise target it. */
export function getContextSelectionPaths(
  selectedPaths: readonly string[],
  targetPath: string,
): string[] {
  return selectedPaths.includes(targetPath) ? [...selectedPaths] : [targetPath];
}

export type ObsidianPointerSelectionMode =
  | "replace"
  | "toggle"
  | "range"
  | "preserve";

/**
 * Obsidian deliberately does not use the platform primary modifier for
 * discontinuous selection: Alt/Option toggles items, Shift selects a range,
 * and Cmd/Ctrl is reserved for opening a file in another tab/pane.
 */
export function getObsidianPointerSelectionMode({
  altKey,
  shiftKey,
  primaryModifierKey,
}: {
  altKey: boolean;
  shiftKey: boolean;
  primaryModifierKey: boolean;
}): ObsidianPointerSelectionMode {
  if (shiftKey) return "range";
  if (primaryModifierKey) return "preserve";
  if (altKey) return "toggle";
  return "replace";
}
