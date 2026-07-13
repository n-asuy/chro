/**
 * Runtime accent derivation: one user-chosen seed -> the full set of
 * accent-bearing CSS variables, readability-clamped per light/dark mode.
 *
 * This is the single source for the accent palette at runtime, mirroring the
 * build-time generator's output contract so the two token namespaces stay
 * consistent (they are emitted together from one seed, never edited apart):
 *   - shadcn HSL semantic tokens as "H S% L%"  -> consumed via hsl(var(--x))
 *   - granular RGB ramp as "r, g, b"           -> consumed via rgb(var(--color-primary-N))
 *
 * Derivation happens in OKLCH (perceptually uniform lightness, hue held
 * constant while scaling lightness) rather than sRGB/HSL, which drift hue and
 * produce muddy, uneven steps for an arbitrary user hue. Lightness is clamped
 * into a per-mode band, chroma is floored (so the ring never vanishes on a
 * grey pick) and capped to the in-gamut maximum, and the text-on-accent
 * foreground is chosen by WCAG contrast ratio.
 */
import {
  type Oklch,
  type Rgb,
  clampChroma,
  converter,
  interpolate,
} from "culori";
import { contrastRatio } from "./contrast";

export type ThemeMode = "light" | "dark";

const toOklch = converter("oklch");
const toRgb = converter("rgb");
const toHsl = converter("hsl");

/**
 * Per-mode derivation anchors. `bg`/`ink` bound the ramp (low steps tint toward
 * the surface, high steps shade toward the ink); the lightness band keeps the
 * solid accent legible against the surface (darker on light, lighter on dark).
 * Values mirror the build-time generator's brand palette endpoints.
 */
export const MODE_ANCHORS: Record<
  ThemeMode,
  { bg: string; ink: string; lMin: number; lMax: number }
> = {
  light: { bg: "#ffffff", ink: "#06243a", lMin: 0.4, lMax: 0.62 },
  dark: { bg: "#1c1d21", ink: "#bfe0fb", lMin: 0.62, lMax: 0.82 },
};

/** Minimum OKLCH chroma so a near-grey pick still reads as a color (ring/selection). */
export const CHROMA_FLOOR = 0.045;
/** Fallback hue (cool blue) when the seed is achromatic and has no hue of its own. */
const NEUTRAL_FALLBACK_HUE = 250;

/** Foreground candidates placed on the accent fill; the higher-contrast one wins. */
const FG_LIGHT: Rgb = { mode: "rgb", r: 1, g: 1, b: 1 };
const FG_DARK: Rgb = {
  mode: "rgb",
  r: 0x0b / 255,
  g: 0x0f / 255,
  b: 0x14 / 255,
};

/** Ramp interpolation fractions, matching the build-time generator's steps. */
const TINT_STEPS: ReadonlyArray<[step: number, t: number]> = [
  [10, 0.08],
  [20, 0.14],
  [30, 0.24],
  [40, 0.38],
  [50, 0.52],
  [60, 0.68],
  [70, 0.84],
  [80, 0.94],
];
const SHADE_STEPS: ReadonlyArray<[step: number, t: number]> = [
  [90, 0.12],
  [200, 0.1],
  [300, 0.2],
  [400, 0.33],
  [500, 0.46],
  [600, 0.58],
  [700, 0.68],
  [800, 0.8],
  [900, 0.9],
];

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));

function rgb255(color: Rgb): [number, number, number] {
  return [
    clamp(Math.round(color.r * 255), 0, 255),
    clamp(Math.round(color.g * 255), 0, 255),
    clamp(Math.round(color.b * 255), 0, 255),
  ];
}

function rgbTriplet(color: Oklch | Rgb): string {
  const [r, g, b] = rgb255(toRgb(color));
  return `${r}, ${g}, ${b}`;
}

function hslTriplet(color: Oklch | Rgb): string {
  const hsl = toHsl(color);
  const h = round1(hsl.h ?? 0);
  const s = round1((hsl.s ?? 0) * 100);
  const l = round1((hsl.l ?? 0) * 100);
  return `${h} ${s}% ${l}%`;
}

/** WCAG contrast ratio of `text` against `bg` (both any culori-parsable color). */
function contrast(text: Oklch | Rgb, bg: Oklch | Rgb): number {
  return contrastRatio(rgb255(toRgb(text)), rgb255(toRgb(bg)));
}

/** Normalize the seed into an in-gamut OKLCH base clamped to the mode's band. */
function baseFor(seedHex: string, mode: ThemeMode): Oklch {
  const parsed = toOklch(seedHex);
  if (!parsed) {
    throw new Error(`accent-derivation: unparsable seed "${seedHex}"`);
  }
  const { lMin, lMax } = MODE_ANCHORS[mode];
  const candidate: Oklch = {
    mode: "oklch",
    l: clamp(parsed.l, lMin, lMax),
    c: Math.max(parsed.c, CHROMA_FLOOR),
    h: parsed.h ?? NEUTRAL_FALLBACK_HUE,
  };
  // Cap chroma to the in-gamut maximum for this hue/lightness so the browser
  // never silently clips (which would shift the hue).
  return clampChroma(candidate, "oklch");
}

/**
 * Derive every accent-bearing CSS variable from a seed for one mode.
 * Keys include the leading `--` so the result can be written straight to an
 * element's inline style. Returns both the HSL semantic tokens and the RGB
 * granular ramp so the two namespaces cannot diverge.
 */
export function deriveAccentVars(
  seedHex: string,
  mode: ThemeMode,
): Record<string, string> {
  const { bg, ink } = MODE_ANCHORS[mode];
  const base = baseFor(seedHex, mode);

  const tint = interpolate([bg, base], "oklch");
  const shade = interpolate([base, ink], "oklch");

  const vars: Record<string, string> = {};

  for (const [step, t] of TINT_STEPS) {
    vars[`--color-primary-${step}`] = rgbTriplet(tint(t));
  }
  vars["--color-primary-100"] = rgbTriplet(base);
  for (const [step, t] of SHADE_STEPS) {
    vars[`--color-primary-${step}`] = rgbTriplet(shade(t));
  }

  // Foreground: pick whichever candidate reads better on the accent fill.
  const fg =
    contrast(FG_LIGHT, base) >= contrast(FG_DARK, base) ? FG_LIGHT : FG_DARK;
  const baseHsl = hslTriplet(base);
  const fgHsl = hslTriplet(fg);

  vars["--primary"] = baseHsl;
  vars["--primary-foreground"] = fgHsl;
  vars["--ring"] = baseHsl;
  vars["--sidebar-primary"] = baseHsl;
  vars["--sidebar-primary-foreground"] = fgHsl;
  vars["--sidebar-ring"] = baseHsl;

  return vars;
}

/**
 * Resilient variant for the apply path: a malformed/unparsable seed (e.g. a
 * hand-edited or future-format `config.json`) degrades to `null` (built-in
 * brand) instead of throwing into a render effect.
 */
export function deriveAccentVarsSafe(
  seedHex: string,
  mode: ThemeMode,
): Record<string, string> | null {
  try {
    return deriveAccentVars(seedHex, mode);
  } catch (error) {
    console.error(
      `accent-derivation: ignoring invalid seed "${seedHex}"`,
      error,
    );
    return null;
  }
}

/** The CSS custom properties this module manages, for clean application/removal. */
export const ACCENT_VAR_NAMES: ReadonlyArray<string> = Object.freeze([
  ...TINT_STEPS.map(([step]) => `--color-primary-${step}`),
  "--color-primary-100",
  ...SHADE_STEPS.map(([step]) => `--color-primary-${step}`),
  "--primary",
  "--primary-foreground",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
]);
