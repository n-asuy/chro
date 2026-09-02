const URL_PROTOCOL = /^[a-z][a-z0-9+.-]*:\/\//i;
const FILE_EXTENSION_TAIL = /\.[A-Za-z0-9]{1,12}(?::\d+(?::\d+)?)?$/;

/**
 * File and folder names with spaces are ordinary on macOS and Windows, so a
 * candidate may contain a few. Prose is excluded by this cap rather than by
 * banning spaces outright: existence is verified before anything renders as a
 * link, so an over-eager candidate costs one probe, not a dead link.
 */
const MAX_SPACES = 3;

export const normalizeFilePathHref = (href: string): string => {
  const trimmed = href.trim();
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
};

/**
 * Cheap shape test for "this text could name a file or folder".
 *
 * Deliberately permissive: it is the first of two tiers, and the second tier
 * (a server probe, see `path-link.ts`) decides link-ness for real. Its job is
 * to keep the obvious non-candidates from costing a round trip.
 */
export const looksLikeFilePath = (text: string): boolean => {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return false;
  if (/[\n\r\t`'"<>]/.test(trimmed)) return false;
  if ((trimmed.match(/ /g)?.length ?? 0) > MAX_SPACES) return false;
  if (URL_PROTOCOL.test(trimmed)) return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed === "/" || trimmed === "//") return false;

  return trimmed.includes("/") || FILE_EXTENSION_TAIL.test(trimmed);
};
