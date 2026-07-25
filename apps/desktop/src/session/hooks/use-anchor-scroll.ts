import { type RefObject, useCallback, useEffect, useRef } from "react";

/**
 * Give up realigning after this long. Long enough for a freshly mounted pane to
 * lay out and for its rows to finish rendering, short enough that a stuck target
 * does not scroll under the user indefinitely.
 */
const ALIGN_TIMEOUT_MS = 2000;
/** Stop once the target has held its position for this many consecutive frames. */
const SETTLE_FRAMES = 3;

/**
 * Scroll a container so a target element sits at its top, and hold it there
 * while the content settles.
 *
 * One scroll is not enough when the content renders asynchronously: the pane may
 * not be laid out yet on the frame the request arrives (the click that opens the
 * tab also mounts it, so its height is briefly 0), and rows above the target keep
 * growing as they render, pushing it back out of view. Those later changes do not
 * re-render the caller, so an initial synchronous scroll (instant feedback, works
 * even before the first animation frame) is followed by an animation-frame loop
 * that re-applies the offset until it holds or a deadline passes.
 *
 * The loop is the single owner of the scheduled frame — nothing else cancels it —
 * so "scroll now" and "content grew" cannot race on a shared frame handle.
 */
export function useAnchorScroll(scrollerRef: RefObject<HTMLElement | null>) {
  const targetRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef(0);
  const settledRef = useRef(0);
  const startRef = useRef(0);
  const lastHeightRef = useRef(-1);

  const stop = useCallback(() => {
    targetRef.current = null;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
  }, []);

  // Bring the target to the top once. Returns whether it is now as close to the
  // top as it can get, given the content rendered so far.
  const alignOnce = useCallback((): "settled" | "moving" | "nolayout" => {
    const scroller = scrollerRef.current;
    const target = targetRef.current;
    if (!scroller || !target) return "nolayout";
    // A pane mid-mount has no height and cannot scroll; wait for one that can.
    if (scroller.clientHeight === 0) return "nolayout";

    const delta =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const maxTop = scroller.scrollHeight - scroller.clientHeight;
    // The last rows cannot reach the very top of the container; being pinned to
    // the bottom is as close as the target gets.
    const atBottom = scroller.scrollTop >= maxTop - 1;
    if (Math.abs(delta) <= 1 || (delta > 0 && atBottom)) return "settled";
    scroller.scrollTop += delta;
    return "moving";
  }, [scrollerRef]);

  const step = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!targetRef.current || !scroller) {
      frameRef.current = 0;
      return;
    }

    // The diff bodies render lazily, so the content keeps growing after the
    // first frames. Only let "settled" count once the height has stopped
    // changing; otherwise the target looks in place merely because the rows
    // below it have not rendered yet, and the loop would stop too early.
    if (scroller.scrollHeight !== lastHeightRef.current) {
      lastHeightRef.current = scroller.scrollHeight;
      settledRef.current = 0;
    }

    const result = alignOnce();
    if (result === "settled") {
      if (++settledRef.current >= SETTLE_FRAMES) {
        stop();
        return;
      }
    } else if (result === "moving") {
      settledRef.current = 0;
    }

    if (performance.now() - startRef.current >= ALIGN_TIMEOUT_MS) {
      stop();
      return;
    }
    frameRef.current = requestAnimationFrame(step);
  }, [scrollerRef, alignOnce, stop]);

  // Any deliberate scroll from the user hands control back to them.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.addEventListener("wheel", stop, { passive: true });
    scroller.addEventListener("touchstart", stop, { passive: true });
    scroller.addEventListener("keydown", stop);
    return () => {
      scroller.removeEventListener("wheel", stop);
      scroller.removeEventListener("touchstart", stop);
      scroller.removeEventListener("keydown", stop);
      cancelAnimationFrame(frameRef.current);
    };
  }, [scrollerRef, stop]);

  useEffect(() => stop, [stop]);

  return useCallback(
    (target: HTMLElement | null) => {
      if (!target) return;
      targetRef.current = target;
      settledRef.current = 0;
      lastHeightRef.current = -1;
      startRef.current = performance.now();
      // Scroll immediately so the reveal feels instant and lands even in a
      // background tab where animation frames are paused; the loop then refines
      // as the diff bodies finish rendering.
      alignOnce();
      cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(step);
    },
    [alignOnce, step],
  );
}
