/**
 * WCAG 2.x relative luminance and contrast ratio.
 *
 * These are the unencumbered W3C Recommendation definitions, used to choose a
 * readable text-on-accent foreground without depending on any patent-pending or
 * field-of-use-restricted contrast algorithm.
 *   - https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 *   - https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */

export type Rgb255 = readonly [r: number, g: number, b: number];

/** Linearize one gamma-encoded sRGB channel (0-255) to its light-linear value. */
function linearizeChannel(srgb8: number): number {
  const c = srgb8 / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (Y, 0-1) of an sRGB [r, g, b] triplet (0-255). */
export function relativeLuminance([r, g, b]: Rgb255): number {
  return (
    0.2126 * linearizeChannel(r) +
    0.7152 * linearizeChannel(g) +
    0.0722 * linearizeChannel(b)
  );
}

/** WCAG contrast ratio (1-21) between two sRGB triplets; order-independent. */
export function contrastRatio(a: Rgb255, b: Rgb255): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
