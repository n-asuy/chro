/**
 * Link clicks reported by the HTML preview frame.
 *
 * The preview loads a document from the file-serving asset endpoint, so links
 * inside it would navigate the frame onto the raw bytes of another file. The
 * server appends a bridge script that forwards those clicks instead (see
 * `preview_link_bridge.js` in the server crate); this module turns a forwarded
 * click into the app-level action it should have been: a workspace file opens
 * as an editor tab, anything on the web goes to the system browser.
 */

import { resolveEmbedPath } from "./embed-path";

/** Message type posted by the bridge script. Must match its constant. */
export const PREVIEW_LINK_MESSAGE_TYPE = "chro:preview-link";

/**
 * Query parameter that opts an asset request into the bridge. Only the
 * top-level preview document sets it, so sub-resources stay verbatim.
 */
export const PREVIEW_LINK_BRIDGE_PARAM = "link_bridge";

export type PreviewLinkMessage = {
  /** The `href` attribute exactly as written in the document. */
  href: string;
  /** `href` resolved against the previewed document's URL. */
  url: string;
  /** Whether the target is served by the asset endpoint, i.e. a local file. */
  local: boolean;
};

export type PreviewLinkTarget =
  | { kind: "file"; path: string }
  | { kind: "external"; url: string };

/** Schemes handed to the system browser. */
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** `scheme:` or `//host` — an address rather than a path within the workspace. */
const HAS_SCHEME_OR_AUTHORITY = /^(?:[a-zA-Z][a-zA-Z\d+\-.]*:|\/\/)/;

/**
 * Validate a `postMessage` payload before trusting any of its fields. The
 * preview renders arbitrary project HTML, so a well-formed shape is the only
 * thing that distinguishes a bridge report from a page's own messaging.
 */
export const parsePreviewLinkMessage = (
  data: unknown,
): PreviewLinkMessage | null => {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.type !== PREVIEW_LINK_MESSAGE_TYPE) return null;
  const { href, url, local } = candidate;
  if (typeof href !== "string") return null;
  if (typeof url !== "string") return null;
  if (typeof local !== "boolean") return null;
  return { href, url, local };
};

/**
 * Undo the percent-encoding the asset URL builder applies per path segment, so
 * a link to `my%20note.md` opens the file actually named `my note.md`.
 */
const decodePathSegments = (path: string): string =>
  path
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

/**
 * Decide what a forwarded click should open. `documentPath` is the previewed
 * file's own path (workspace-relative, or host-absolute when it was opened
 * from outside a workspace root), which is what gives a relative link its
 * meaning.
 *
 * Returns `null` when the click has no app-level action, in which case nothing
 * happens — the bridge already suppressed the frame navigation.
 */
export const resolvePreviewLinkTarget = (
  message: PreviewLinkMessage,
  documentPath: string | null,
): PreviewLinkTarget | null => {
  const href = message.href.trim();
  // A bare fragment belongs to the previewed document; the bridge never
  // forwards one, but the guard keeps this function total.
  if (!href || href.startsWith("#")) return null;

  if (!message.local) {
    let protocol: string;
    try {
      protocol = new URL(message.url).protocol;
    } catch {
      return null;
    }
    if (!EXTERNAL_PROTOCOLS.has(protocol)) return null;
    return { kind: "external", url: message.url };
  }

  // Same origin, yet written as a full address: it names a route on the asset
  // server rather than a path inside the document's own space, and the route
  // prefix is not something a file path can be recovered from.
  if (HAS_SCHEME_OR_AUTHORITY.test(href)) return null;

  const [withoutFragment = ""] = href.split("#");
  const [pathPart = ""] = withoutFragment.split("?");
  if (!pathPart) return null;

  const path = resolveEmbedPath(documentPath, decodePathSegments(pathPart));
  if (!path || path === "/") return null;
  return { kind: "file", path };
};
