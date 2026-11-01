import { describe, expect, it } from "vitest";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  anchoredScroll,
  clampZoom,
  fitScale,
  imageOffset,
  orientedSize,
  pinchFactor,
} from "./image-zoom";

describe("clampZoom", () => {
  it("keeps the zoom inside the supported range", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe("orientedSize", () => {
  it("swaps the axes for quarter turns", () => {
    const size = { width: 100, height: 400 };
    expect(orientedSize(size, 0)).toEqual(size);
    expect(orientedSize(size, 90)).toEqual({ width: 400, height: 100 });
    expect(orientedSize(size, 180)).toEqual(size);
    expect(orientedSize(size, 270)).toEqual({ width: 400, height: 100 });
  });
});

describe("fitScale", () => {
  it("shrinks a tall image to the viewport height", () => {
    expect(
      fitScale({ width: 1844, height: 4041 }, { width: 1000, height: 808 }, 0),
    ).toBeCloseTo(0.2);
  });

  it("never upscales an image smaller than the viewport", () => {
    expect(
      fitScale({ width: 100, height: 100 }, { width: 1000, height: 800 }, 0),
    ).toBe(1);
  });

  it("subtracts the padding on both sides", () => {
    expect(
      fitScale({ width: 400, height: 100 }, { width: 264, height: 800 }, 32),
    ).toBe(0.5);
  });
});

describe("imageOffset", () => {
  it("centers content smaller than the viewport", () => {
    expect(imageOffset(1000, 200, 32)).toBe(400);
  });

  it("starts at the padding once content overflows", () => {
    expect(imageOffset(1000, 3000, 32)).toBe(32);
  });
});

describe("anchoredScroll", () => {
  const viewport = { width: 1000, height: 800 };

  it("keeps the image point under the anchor fixed while zooming in", () => {
    // 500x400 image centered in 1000x800: offset (250, 200). The anchor at
    // the image center (500, 400) must stay over the image center at 4x.
    const next = anchoredScroll({
      viewport,
      padding: 0,
      scroll: { left: 0, top: 0 },
      anchor: { x: 500, y: 400 },
      from: { width: 500, height: 400 },
      to: { width: 2000, height: 1600 },
    });
    expect(next).toEqual({ left: 500, top: 400 });
  });

  it("clamps to the scrollable range", () => {
    // Anchoring on the image's top-left corner would need a negative scroll.
    const next = anchoredScroll({
      viewport,
      padding: 0,
      scroll: { left: 0, top: 0 },
      anchor: { x: 250, y: 200 },
      from: { width: 500, height: 400 },
      to: { width: 2000, height: 1600 },
    });
    expect(next).toEqual({ left: 0, top: 0 });
  });

  it("accounts for the current scroll and padding", () => {
    // Overflowing 2000px image at offset 32, scrolled 532: the anchor at
    // x=100 sits on image x=600 (30%). At 4000px that point is x=1200.
    const next = anchoredScroll({
      viewport,
      padding: 32,
      scroll: { left: 532, top: 0 },
      anchor: { x: 100, y: 0 },
      from: { width: 2000, height: 800 },
      to: { width: 4000, height: 800 },
    });
    expect(next.left).toBe(32 + 1200 - 100);
  });
});

describe("pinchFactor", () => {
  it("grows on a negative wheel delta and shrinks on a positive one", () => {
    expect(pinchFactor(-10)).toBeGreaterThan(1);
    expect(pinchFactor(10)).toBeLessThan(1);
    expect(pinchFactor(0)).toBe(1);
  });

  it("is symmetric so pinching out and back returns to the start", () => {
    expect(pinchFactor(-25) * pinchFactor(25)).toBeCloseTo(1);
  });
});
