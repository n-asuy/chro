/**
 * Web address recognition for agent output.
 *
 * Agent prose is full of dotted tokens and only some of them are web
 * addresses: `chro-ai.com` is a site, `README.md` and `main.rs` are files.
 * The two readings share the same shape, so the last label decides — a
 * curated set of top-level domains that common file extensions do not
 * collide with. `.md`, `.rs`, `.sh`, `.so`, `.py`, `.pl`, `.zip` and `.mov`
 * are real TLDs but are far more often file extensions in this context, so
 * they are left out on purpose: a domain that stays plain text is a small
 * loss, a file path that opens a browser is a wrong action.
 */

const WEB_TLDS = new Set([
  // generic
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "int",
  "info",
  "biz",
  "io",
  "ai",
  "dev",
  "app",
  "co",
  "cloud",
  "page",
  "site",
  "tech",
  "xyz",
  "blog",
  "wiki",
  "news",
  "live",
  "chat",
  "email",
  "link",
  "shop",
  "store",
  "studio",
  "design",
  "space",
  "world",
  "media",
  "systems",
  "tools",
  "me",
  "tv",
  "cc",
  "gg",
  "fm",
  "ly",
  // country
  "jp",
  "us",
  "uk",
  "ca",
  "au",
  "nz",
  "de",
  "fr",
  "it",
  "es",
  "nl",
  "be",
  "ch",
  "at",
  "se",
  "fi",
  "dk",
  "ie",
  "pt",
  "cz",
  "gr",
  "il",
  "tr",
  "ru",
  "cn",
  "kr",
  "tw",
  "hk",
  "sg",
  "in",
  "id",
  "th",
  "vn",
  "ph",
  "br",
  "mx",
  "za",
]);

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HTTP_SCHEME = /^https?:\/\//i;
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const UNSAFE_CHARS = /[\s`'"<>\\]/;

/** Host labels that read as a web host and end in a curated TLD. */
const isWebHost = (host: string): boolean => {
  const labels = host.toLowerCase().split(".");
  if (labels.length < 2) {
    return false;
  }
  if (!labels.every((label) => HOST_LABEL.test(label))) {
    return false;
  }
  return WEB_TLDS.has(labels[labels.length - 1]);
};

/**
 * Resolve `value` to an absolute web URL when it reads as a web address,
 * otherwise `null`. Accepts an explicit `http(s)` URL and a scheme-less
 * address (`chro-ai.com`, `chro-ai.com/dl`), which is how addresses are
 * usually written in prose; everything else — local paths, other schemes,
 * `host:port`, bare file names — is left to the file path handling.
 */
export const resolveWebUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || UNSAFE_CHARS.test(trimmed)) {
    return null;
  }

  if (HTTP_SCHEME.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return isWebHost(parsed.hostname) || parsed.hostname === "localhost"
        ? trimmed
        : null;
    } catch {
      return null;
    }
  }

  // `mailto:`, `file:`, `C:/...`, `chro-ai.com:8080` — none of these are
  // addresses this opens, and a scheme-less address never contains a colon.
  if (ANY_SCHEME.test(trimmed)) {
    return null;
  }
  if (/^[/.~#]/.test(trimmed)) {
    return null;
  }

  const host = trimmed.split(/[/?#]/)[0] ?? "";
  return isWebHost(host) ? `https://${trimmed}` : null;
};
