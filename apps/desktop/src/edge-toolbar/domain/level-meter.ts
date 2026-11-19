/**
 * The microphone button's live level meter while listening: the four bars of
 * the mock's `.bars`, their heights following the input level. The shell
 * sends levels (0..1, already smoothed) in batches, about 30 a second; they
 * are played back one per interval, and the bars show the latest four,
 * oldest on the left, so the voice moves across them.
 */

/** The bars' full heights in px (the mock's 9, 13, 13, 12). */
export const BAR_MAX_PX = [9, 13, 13, 12] as const;

/** A bar's height in silence: a short, still stub. */
export const BAR_MIN_PX = 3;

/** Levels waiting longer than this many steps are dropped (stay live). */
export const MAX_QUEUED = 6;

/** The heights of the four bars for the latest levels (oldest first). */
export function barHeights(recent: readonly number[]): number[] {
  return BAR_MAX_PX.map((max, i) => {
    const level = recent[recent.length - BAR_MAX_PX.length + i] ?? 0;
    const clamped = Math.min(1, Math.max(0, level));
    return Math.round((BAR_MIN_PX + (max - BAR_MIN_PX) * clamped) * 10) / 10;
  });
}

/** Queue a batch; when playback falls behind, keep only the newest. */
export function enqueueLevels(
  queue: readonly number[],
  levels: readonly number[],
): number[] {
  const next = [...queue, ...levels];
  return next.length > MAX_QUEUED ? next.slice(-MAX_QUEUED) : next;
}

/** The latest levels after one more is played (the last four are kept). */
export function pushRecent(recent: readonly number[], level: number): number[] {
  return [...recent, level].slice(-BAR_MAX_PX.length);
}
