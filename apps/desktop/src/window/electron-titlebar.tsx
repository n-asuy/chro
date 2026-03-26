import { type CSSProperties } from "react";

const DRAG_REGION: CSSProperties = {
  WebkitAppRegion: "drag",
} as CSSProperties;

/**
 * Invisible window drag region overlaid at the top of the window.
 * In the Tana-style layout the traditional titlebar is removed;
 * dragging is handled by a transparent fixed strip.
 */
export const ElectronTitlebar = () => (
  <div
    className="fixed top-0 left-0 w-full h-8 z-50 pointer-events-none"
    style={DRAG_REGION}
  />
);
