import { useEffect, useRef, useState } from "react";
import { barHeights, enqueueLevels, pushRecent } from "../domain/level-meter";
import { onTalkLevels } from "../lib/edge-input-client";

/** Playback step until the shell says otherwise (about 30 a second). */
const DEFAULT_INTERVAL_MS = 1000 / 30;

/**
 * The microphone's live level meter (in place of the mock's animated
 * `.bars`): four white bars whose heights follow the input level, low and
 * still in silence. Only this component re-renders at the meter's rate.
 */
export function EdgeLevelBars() {
  const [recent, setRecent] = useState<number[]>([]);
  const queue = useRef<number[]>([]);
  const interval = useRef(DEFAULT_INTERVAL_MS);

  useEffect(() => {
    const stop = onTalkLevels((batch) => {
      interval.current = batch.intervalMs || DEFAULT_INTERVAL_MS;
      queue.current = enqueueLevels(queue.current, batch.levels);
    });
    let frame = 0;
    let last = performance.now();
    const step = (now: number) => {
      if (now - last >= interval.current) {
        last = now;
        const [level, ...rest] = queue.current;
        if (level !== undefined) {
          queue.current = rest;
          setRecent((current) => pushRecent(current, level));
        }
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => {
      stop();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <span className="edge-bars" aria-hidden="true">
      {barHeights(recent).map((height, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the four bars are fixed positions
        <i key={index} style={{ height }} />
      ))}
    </span>
  );
}
