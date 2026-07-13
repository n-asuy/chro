import changelogSource from "virtual:chro-changelog";
import { type ChangelogRelease, parseChangelog } from "./changelog-parser";

export type { ChangelogRelease } from "./changelog-parser";
export { splitInlineCode } from "./changelog-parser";

/**
 * Release history for this build, parsed once from the bundled CHANGELOG.md.
 * Newest release first.
 */
export const CHANGELOG_RELEASES: ChangelogRelease[] =
  parseChangelog(changelogSource);

/**
 * The version this binary was built as, from Vite's `__APP_VERSION__` define
 * (package.json version, overridable via `VITE_APP_VERSION`). Normalized without
 * a leading `v` so it compares directly against changelog headings.
 */
export const CURRENT_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__.trim() : "";

/** Whether a given changelog version matches the running build. */
export function isCurrentVersion(version: string): boolean {
  if (!CURRENT_VERSION) return false;
  const normalize = (value: string) => value.replace(/^v/i, "").trim();
  return normalize(version) === normalize(CURRENT_VERSION);
}
