import { getWorkspaceBinaryFileUrl } from "@/lib/project-client";
import type { PathLinkTarget } from "./path-link";

/**
 * Where an image an agent wrote into its reply (`![shot](/tmp/shot.png)`) is
 * loaded from.
 *
 * Web and inline images load as written. Anything else is a local file, which
 * the webview cannot read directly and the backend serves. An absolute path
 * names its file outright, so it is served as written and the image request
 * itself is the existence check. A relative path is first resolved like any
 * other path reference (see `path-link.ts`).
 */

const REMOTE_IMAGE_PATTERN = /^(https?:\/\/|data:image\/)/i;
const ABSOLUTE_PATH_PATTERN = /^(?:\/(?!\/)|[A-Za-z]:[\\/])/;
const ATTACHED_IMAGE_PATTERN = /(?:^|\/)(\.chro-context\/[^/]+)$/;

/**
 * The canonical `.chro-context/<file>` path of an image the user attached, or
 * null when `src` is not one. The agent receives attachments as absolute
 * worktree paths and echoes them back in the user message, so both spellings
 * name the same attachment.
 */
export const attachedImagePath = (src: string): string | null =>
  remoteImageSource(src)
    ? null
    : ATTACHED_IMAGE_PATTERN.exec(src.trim())?.[1] ?? null;

export const remoteImageSource = (src: string): string | null => {
  const trimmed = src.trim();
  return REMOTE_IMAGE_PATTERN.test(trimmed) ? trimmed : null;
};

/**
 * The file an absolute image path names, or null when the path is relative
 * (or home-relative: `~` is expanded only by resolution) and must be resolved
 * first.
 */
export const absoluteImageTarget = (src: string): PathLinkTarget | null => {
  const path = src.trim();
  if (!ABSOLUTE_PATH_PATTERN.test(path)) return null;
  return {
    kind: "file",
    absolutePath: path,
    root: null,
    line: null,
    column: null,
  };
};

export const localImageSource = (
  target: PathLinkTarget | null,
): string | null => {
  if (target?.kind !== "file") return null;
  const { absolutePath } = target;
  const separator = Math.max(
    absolutePath.lastIndexOf("/"),
    absolutePath.lastIndexOf("\\"),
  );
  if (separator < 0) return null;
  return getWorkspaceBinaryFileUrl(
    absolutePath.slice(0, separator) || "/",
    absolutePath.slice(separator + 1),
  );
};
