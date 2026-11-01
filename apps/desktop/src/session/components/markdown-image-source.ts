import { getWorkspaceBinaryFileUrl } from "@/lib/project-client";
import type { PathLinkTarget } from "./path-link";

/**
 * Where an image an agent wrote into its reply (`![shot](/tmp/shot.png)`) is
 * loaded from.
 *
 * Web and inline images load as written. Anything else is a local path, which
 * the webview cannot read directly: it is resolved like any other path
 * reference (see `path-link.ts`) and then served by the backend.
 */

const REMOTE_IMAGE_PATTERN = /^(https?:\/\/|data:image\/)/i;
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
    : (ATTACHED_IMAGE_PATTERN.exec(src.trim())?.[1] ?? null);

export const remoteImageSource = (src: string): string | null => {
  const trimmed = src.trim();
  return REMOTE_IMAGE_PATTERN.test(trimmed) ? trimmed : null;
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
