import { describe, expect, it } from "vitest";
import {
  PROJECT_COLOR_NAMES,
  hsvToHex,
  isProjectColorName,
  normalizeBadgeColor,
  projectBadgeColor,
  projectColorValue,
} from "./project-color";

describe("normalizeBadgeColor", () => {
  it("accepts 6-digit hex with or without hash and lowercases", () => {
    expect(normalizeBadgeColor("#8A6AD2")).toBe("#8a6ad2");
    expect(normalizeBadgeColor("8a6ad2")).toBe("#8a6ad2");
  });

  it("expands 3-digit hex", () => {
    expect(normalizeBadgeColor("#fa0")).toBe("#ffaa00");
  });

  it("trims whitespace", () => {
    expect(normalizeBadgeColor("  #45a49b ")).toBe("#45a49b");
  });

  it("rejects garbage", () => {
    for (const invalid of ["", "#", "#12", "#12345", "red", "#ggg"]) {
      expect(normalizeBadgeColor(invalid)).toBeNull();
    }
  });
});

describe("projectBadgeColor", () => {
  it("returns null when no color is assigned (no dot)", () => {
    expect(projectBadgeColor(null)).toBeNull();
    expect(projectBadgeColor(undefined)).toBeNull();
    expect(projectBadgeColor("")).toBeNull();
  });

  it("resolves preset names to theme-aware variables", () => {
    expect(projectBadgeColor("teal")).toBe("var(--color-project-teal)");
  });

  it("passes custom hex through verbatim", () => {
    expect(projectBadgeColor("#8a6ad2")).toBe("#8a6ad2");
  });
});

describe("isProjectColorName / projectColorValue", () => {
  it("recognizes every palette name", () => {
    for (const name of PROJECT_COLOR_NAMES) {
      expect(isProjectColorName(name)).toBe(true);
      expect(projectColorValue(name)).toBe(`var(--color-project-${name})`);
    }
  });

  it("rejects non-palette strings", () => {
    expect(isProjectColorName("#8a6ad2")).toBe(false);
    expect(isProjectColorName("crimson")).toBe(false);
  });
});

describe("hsvToHex", () => {
  it("converts primary corners", () => {
    expect(hsvToHex(0, 1, 1)).toBe("#ff0000");
    expect(hsvToHex(120, 1, 1)).toBe("#00ff00");
    expect(hsvToHex(240, 1, 1)).toBe("#0000ff");
  });

  it("desaturates toward gray", () => {
    expect(hsvToHex(0, 0, 0.5)).toBe("#808080");
  });
});
