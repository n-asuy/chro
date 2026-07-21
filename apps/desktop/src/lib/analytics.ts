import posthog from "posthog-js";

const POSTHOG_KEY = "phc_ciDHQIDUgIxsl1Z5oqbhfHq6Hj2ktS4hdImRC649dZ9";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let initialized = false;

/**
 * Strip file paths down to just the extension to avoid leaking
 * user directory structures into analytics.
 * e.g. "/Users/foo/project/src/main.tsx" → "*.tsx"
 *      "C:\\Users\\bar\\doc.pdf" → "*.pdf"
 */
function maskPath(path: string): string {
  const basename = path.split(/[/\\]/).pop() ?? path;
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex >= 0) {
    return `*${basename.slice(dotIndex)}`;
  }
  return "*";
}

const PATH_LIKE_KEYS = new Set([
  "workspace_path",
  "container_ref",
  "file_path",
  "old_path",
  "new_path",
  "path",
]);

function sanitizeProperties(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (PATH_LIKE_KEYS.has(key) && typeof value === "string") {
      sanitized[key] = maskPath(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function initAnalytics(options?: { enabled?: boolean }): void {
  if (initialized) {
    return;
  }

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    persistence: "localStorage",
    disable_session_recording: true,
    // Feature flags are resolved once by the backend and read through
    // `useFlag`. Letting posthog-js resolve them again here would produce a
    // second, independent answer that the UI never gates on.
    advanced_disable_feature_flags: true,
    loaded: (ph) => {
      if (options?.enabled === false) {
        ph.opt_out_capturing();
      }
    },
  });

  initialized = true;
}

/**
 * Enable or disable capturing at runtime (user preference toggle).
 */
export function setAnalyticsEnabled(enabled: boolean): void {
  if (!initialized) return;
  if (enabled) {
    posthog.opt_in_capturing();
  } else {
    posthog.opt_out_capturing();
  }
}

/**
 * Capture a custom event. No-op when PostHog is not initialized or opted out.
 * Path-like properties are automatically masked to prevent leaking
 * user directory structures.
 */
export function capture(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!initialized) return;
  posthog.capture(event, {
    ...(properties ? sanitizeProperties(properties) : undefined),
    app_version: __APP_VERSION__,
  });
}

/**
 * Identify the current user.
 */
export function identify(
  distinctId: string,
  properties?: Record<string, unknown>,
): void {
  if (!initialized) return;
  posthog.identify(distinctId, properties);
}

export { posthog };
