/**
 * Pure parsing of the project CHANGELOG.md into structured releases.
 *
 * Kept free of any build-time (`virtual:`) or DOM imports so it can be unit
 * tested in isolation and reused by both the renderer and tooling. The raw
 * source is injected by {@link ../system/changelog.ts}, which owns the wiring to
 * the bundled markdown.
 */

/** One released version and its human-facing bullet notes. */
export interface ChangelogRelease {
  /** Version string exactly as written in the heading, e.g. `"0.1.40"`. */
  version: string;
  /** Bullet items, in document order, with the list marker stripped. */
  notes: string[];
}

const RELEASE_HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.*)$/;

/**
 * Parse a CHANGELOG.md body into releases, newest first (document order).
 *
 * Recognizes `## <version>` as a release boundary and `- ` / `* ` lines as
 * bullet notes. A non-empty, non-heading, non-bullet line that follows a bullet
 * is treated as a wrapped continuation of that bullet, so long notes that span
 * multiple source lines stay a single item. Anything before the first release
 * heading (the top-level `# Changelog` title, intro prose) is ignored.
 */
export function parseChangelog(source: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let current: ChangelogRelease | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const heading = rawLine.match(RELEASE_HEADING);
    if (heading) {
      current = { version: heading[1], notes: [] };
      releases.push(current);
      continue;
    }

    if (!current) continue;

    const bullet = rawLine.match(BULLET);
    if (bullet) {
      current.notes.push(bullet[1].trim());
      continue;
    }

    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Wrapped continuation of the previous bullet.
    if (current.notes.length > 0) {
      const last = current.notes.length - 1;
      current.notes[last] = `${current.notes[last]} ${line}`;
    }
  }

  return releases;
}

/** A run of changelog text, tagged as inline `code` or plain prose. */
export interface InlineSegment {
  code: boolean;
  text: string;
}

/**
 * Split a note into alternating plain / inline-code segments on backtick pairs,
 * so the renderer can style `` `code` `` spans without pulling in a markdown
 * engine. An unterminated backtick is treated as literal text.
 */
export function splitInlineCode(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf("`", index);
    if (open === -1) {
      segments.push({ code: false, text: text.slice(index) });
      break;
    }
    const close = text.indexOf("`", open + 1);
    if (close === -1) {
      segments.push({ code: false, text: text.slice(index) });
      break;
    }
    if (open > index) {
      segments.push({ code: false, text: text.slice(index, open) });
    }
    segments.push({ code: true, text: text.slice(open + 1, close) });
    index = close + 1;
  }

  return segments.filter((segment) => segment.text.length > 0);
}
