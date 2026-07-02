import { APCAcontrast, sRGBtoY } from "apca-w3";
import { type Rgb, converter } from "culori";
import { describe, expect, it, vi } from "vitest";
import {
  ACCENT_VAR_NAMES,
  CHROMA_FLOOR,
  MODE_ANCHORS,
  type ThemeMode,
  deriveAccentVars,
  deriveAccentVarsSafe,
} from "./accent-derivation";

const toRgb = converter("rgb");
const toOklch = converter("oklch");

const RAMP_STEPS = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800,
  900,
];

function hslTripletToColor(triplet: string) {
  const [h, s, l] = triplet.replace(/%/g, "").trim().split(/\s+/).map(Number);
  return { mode: "hsl" as const, h, s: s / 100, l: l / 100 };
}

function rgbTripletToColor(triplet: string): Rgb {
  const [r, g, b] = triplet.split(",").map((p) => Number(p.trim()));
  return { mode: "rgb", r: r / 255, g: g / 255, b: b / 255 };
}

function rgb255(color: Rgb): [number, number, number] {
  return [
    Math.round(color.r * 255),
    Math.round(color.g * 255),
    Math.round(color.b * 255),
  ];
}

function asRgb(color: string | Rgb): Rgb {
  const rgb = typeof color === "string" ? toRgb(color) : color;
  if (!rgb) throw new Error(`unparsable color: ${String(color)}`);
  return rgb;
}

function seedHue(seed: string): number {
  const oklch = toOklch(seed);
  return oklch?.h ?? 0;
}

function apca(text: string | Rgb, bg: string | Rgb): number {
  return Math.abs(
    Number(
      APCAcontrast(sRGBtoY(rgb255(asRgb(text))), sRGBtoY(rgb255(asRgb(bg)))),
    ),
  );
}

const SEEDS = {
  brand: "#0c6cbe",
  red: "#e5484d",
  green: "#30a46c",
  neonYellow: "#ffff00",
  lime: "#bef264",
  cyan: "#22d3ee",
  magenta: "#d946ef",
  grey: "#808080",
  nearWhite: "#f5f5f5",
  nearBlack: "#111111",
};
const CHROMATIC_SEEDS = [
  "brand",
  "red",
  "green",
  "neonYellow",
  "lime",
  "cyan",
  "magenta",
];
const MODES: ThemeMode[] = ["light", "dark"];

describe("deriveAccentVars", () => {
  it("emits every managed variable, including the full 18-step ramp", () => {
    const vars = deriveAccentVars(SEEDS.brand, "light");

    for (const name of ACCENT_VAR_NAMES) {
      expect(vars[name], `missing ${name}`).toBeTypeOf("string");
    }
    for (const step of RAMP_STEPS) {
      expect(vars[`--color-primary-${step}`]).toBeTypeOf("string");
    }
    // No stray keys beyond the declared contract.
    expect(Object.keys(vars).sort()).toEqual([...ACCENT_VAR_NAMES].sort());
  });

  it("produces only parseable, in-range color values", () => {
    const vars = deriveAccentVars(SEEDS.magenta, "dark");
    for (const [name, value] of Object.entries(vars)) {
      const color = name.startsWith("--color-primary-")
        ? rgbTripletToColor(value)
        : toRgb(hslTripletToColor(value));
      const [r, g, b] = rgb255(color);
      for (const channel of [r, g, b]) {
        expect(channel, `${name}=${value}`).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });

  it("is deterministic", () => {
    expect(deriveAccentVars(SEEDS.cyan, "light")).toEqual(
      deriveAccentVars(SEEDS.cyan, "light"),
    );
  });

  it("degrades a malformed seed to null instead of throwing (apply path)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(deriveAccentVarsSafe("not-a-color", "light")).toBeNull();
    expect(deriveAccentVarsSafe("#7c3aed", "dark")).not.toBeNull();
    errorSpy.mockRestore();
  });

  for (const mode of MODES) {
    for (const [name, seed] of Object.entries(SEEDS)) {
      describe(`${seed} (${name}) in ${mode}`, () => {
        const vars = deriveAccentVars(seed, mode);
        const primary = toRgb(hslTripletToColor(vars["--primary"]));
        const fg = toRgb(hslTripletToColor(vars["--primary-foreground"]));
        const primaryOklch = toOklch(primary);

        it("keeps the text-on-accent foreground readable (APCA Lc >= 45)", () => {
          expect(apca(fg, primary)).toBeGreaterThanOrEqual(45);
        });

        it("keeps the accent distinguishable from the surface (APCA Lc >= 20)", () => {
          expect(apca(primary, MODE_ANCHORS[mode].bg)).toBeGreaterThanOrEqual(
            20,
          );
        });

        it("floors chroma so the ring never vanishes on neutral surfaces", () => {
          // Small slack absorbs the 1-decimal HSL-triplet quantization of the
          // emitted --primary value; the ring is still visibly chromatic.
          expect(primaryOklch.c).toBeGreaterThanOrEqual(CHROMA_FLOOR - 0.005);
        });
      });
    }
  }

  for (const mode of MODES) {
    for (const name of CHROMATIC_SEEDS) {
      it(`preserves the chosen hue for ${name} in ${mode} (no OKLCH hue drift)`, () => {
        const seed = SEEDS[name as keyof typeof SEEDS];
        const inputHue = seedHue(seed);
        const primaryColor = asRgb(
          toRgb(hslTripletToColor(deriveAccentVars(seed, mode)["--primary"])),
        );
        const primaryHue = toOklch(primaryColor)?.h ?? 0;
        const delta = Math.abs(((primaryHue - inputHue + 540) % 360) - 180);
        expect(delta).toBeLessThanOrEqual(8);
      });
    }
  }
});
