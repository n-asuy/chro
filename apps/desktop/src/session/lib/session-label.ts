/** Long enough to tell sessions apart, short enough to sit inside a sentence. */
const LABEL_MAX_CHARS = 24;

/**
 * How a session reads wherever it is referenced (a mention in prose, a pill in
 * the composer or a sent message): the opening of its title, or `fallback`
 * (its slug or short id) when it has none.
 */
export function sessionMentionLabel(title: string, fallback: string): string {
  const trimmed = title.trim();
  if (!trimmed) return fallback;
  const chars = Array.from(trimmed);
  if (chars.length <= LABEL_MAX_CHARS) return trimmed;
  return `${chars.slice(0, LABEL_MAX_CHARS).join("").trimEnd()}…`;
}
