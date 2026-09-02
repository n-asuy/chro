import posthog from "posthog-js";

import { recordDevEvent } from "./dev-events";

const POSTHOG_KEY = "phc_ciDHQIDUgIxsl1Z5oqbhfHq6Hj2ktS4hdImRC649dZ9";
const POSTHOG_HOST = "https://eu.i.posthog.com";

/**
 * Events allowed to leave the machine.
 *
 * Every captured event is mirrored into the local dev sink, which records far
 * more than a user ever consented to share. This list -- not the call site --
 * decides what reaches PostHog, so a new instrumentation point is local-only
 * until it is deliberately added here. Keep it in step with `EGRESS_ALLOWLIST`
 * in `crates/analytics/src/lib.rs`.
 */
const EGRESS_ALLOWLIST = new Set([
  "execution_started",
  "execution_completed",
  "execution_failed",
  "app_opened",
  "error_boundary",
]);

export function isEgressAllowed(event: string): boolean {
  return EGRESS_ALLOWLIST.has(event);
}

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
 * Capture a custom event.
 *
 * Always mirrored to the local dev sink. Transmission to PostHog additionally
 * requires initialization, the user opt-in, and membership of the egress
 * allowlist; path-like properties are masked on the way out, never on the way
 * to disk.
 */
export function capture(
  event: string,
  properties?: Record<string, unknown>,
): void {
  recordDevEvent(event, properties);

  if (!initialized) return;
  if (!isEgressAllowed(event)) {
    console.warn(
      `[analytics] "${event}" is not on the egress allowlist; kept local`,
    );
    return;
  }
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
