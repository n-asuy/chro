// Geometry for the image viewer: fit-to-viewport sizing and cursor-anchored
// zoom. The viewer lays the image out in a scroll container whose content is
// `max(viewport, image + 2 * padding)` wide and centers the image inside it,
// so every edge of an enlarged image stays reachable by scrolling.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 8;

// Wheel delta (px) to zoom exponent. ctrl+wheel pinch deltas are small, so
// this is tuned to track the fingers roughly 1:1 on a trackpad.
const PINCH_SENSITIVITY = 0.01;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ScrollPosition {
  left: number;
  top: number;
}

export const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export const orientedSize = (size: Size, rotation: number): Size =>
  rotation % 180 === 0 ? size : { width: size.height, height: size.width };

/** Scale that fits the (rotated) image inside the viewport, never upscaling. */
export const fitScale = (
  natural: Size,
  viewport: Size,
  padding: number,
): number => {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  return Math.min(
    1,
    availableWidth / natural.width,
    availableHeight / natural.height,
  );
};

/** Position of the image's leading edge inside the scroll content on one axis. */
export const imageOffset = (
  viewportLength: number,
  imageLength: number,
  padding: number,
): number => {
  const contentLength = Math.max(viewportLength, imageLength + padding * 2);
  return (contentLength - imageLength) / 2;
};

const anchoredAxis = (
  viewportLength: number,
  padding: number,
  scroll: number,
  anchor: number,
  from: number,
  to: number,
): number => {
  const fraction =
    (scroll + anchor - imageOffset(viewportLength, from, padding)) / from;
  const target =
    imageOffset(viewportLength, to, padding) + fraction * to - anchor;
  const maxScroll = Math.max(0, to + padding * 2 - viewportLength);
  return Math.min(maxScroll, Math.max(0, target));
};

/**
 * Scroll position after resizing the image from `from` to `to` that keeps
 * the image point under `anchor` (viewport-relative) in place.
 */
export const anchoredScroll = ({
  viewport,
  padding,
  scroll,
  anchor,
  from,
  to,
}: {
  viewport: Size;
  padding: number;
  scroll: ScrollPosition;
  anchor: Point;
  from: Size;
  to: Size;
}): ScrollPosition => ({
  left: anchoredAxis(
    viewport.width,
    padding,
    scroll.left,
    anchor.x,
    from.width,
    to.width,
  ),
  top: anchoredAxis(
    viewport.height,
    padding,
    scroll.top,
    anchor.y,
    from.height,
    to.height,
  ),
});

/** Zoom multiplier for a ctrl+wheel (trackpad pinch) delta in pixels. */
export const pinchFactor = (deltaY: number) =>
  Math.exp(-deltaY * PINCH_SENSITIVITY);
