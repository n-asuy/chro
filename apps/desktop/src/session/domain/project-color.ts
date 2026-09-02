/**
 * Project identity color.
 *
 * A project renders a small colored dot next to its name in the sidebar, but
 * only when the user explicitly assigned a color: an unset `badge_color`
 * means no dot at all. Presets are persisted by name so they resolve through
 * theme-aware CSS variables (`--color-project-*`); custom picks are persisted
 * as concrete `#rrggbb` hex.
 */

export const PROJECT_COLOR_NAMES = [
  "neutral",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
] as const;

export type ProjectColorName = (typeof PROJECT_COLOR_NAMES)[number];

export function isProjectColorName(value: string): value is ProjectColorName {
  return (PROJECT_COLOR_NAMES as readonly string[]).includes(value);
}

/** CSS value for a preset palette name. */
export function projectColorValue(name: ProjectColorName): string {
  return `var(--color-project-${name})`;
}

/**
 * Normalize a hex color into canonical `#rrggbb` form, mirroring the server's
 * `normalize_badge_color`. Returns null for anything invalid.
 */
export function normalizeBadgeColor(value: string): string | null {
  const trimmed = value.trim();
  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length === 3) {
    return `#${hex
      .split("")
      .map((c) => c + c)
      .join("")
      .toLowerCase()}`;
  }
  if (hex.length === 6) return `#${hex.toLowerCase()}`;
  return null;
}

/**
 * CSS color for an explicitly assigned badge color: preset names resolve to
 * their theme-aware variable, custom hex renders verbatim. Null when the
 * project has no color (no dot is rendered).
 */
export function projectBadgeColor(
  badgeColor: string | null | undefined,
): string | null {
  if (!badgeColor) return null;
  return isProjectColorName(badgeColor)
    ? projectColorValue(badgeColor)
    : badgeColor;
}

/** HSV → `#rrggbb`, used by the custom color field in the picker. */
export function hsvToHex(h: number, s: number, v: number): string {
  const channel = (n: number): string => {
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}
