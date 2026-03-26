#!/usr/bin/env python3
"""Generate tray icon assets for Chro desktop.

This script creates a minimal pair of PNG files:
  - apps/desktop/assets/tray/trayTemplate.png  (monochrome template for macOS)
  - apps/desktop/assets/tray/tray.png          (default coloured icon)

The images are intentionally small so the Electron tray badge overlay looks
compact.  Adjust `CANVAS_SIZE` if the design needs to be tweaked later.

Requires Pillow::
    pip install pillow
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ASSET_DIR = ROOT / "apps" / "desktop" / "assets" / "tray"

CANVAS_SIZE = 36  # draw at 2x for crisper downscale
OUTER_RADIUS = CANVAS_SIZE // 2
STROKE_WIDTH = 4
ACCENT_DIAMETER = 10


def generate_template(path: Path) -> None:
    img = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse(
        [STROKE_WIDTH, STROKE_WIDTH, CANVAS_SIZE - STROKE_WIDTH, CANVAS_SIZE - STROKE_WIDTH],
        fill=(255, 255, 255, 255),
    )
    img.save(path)


def generate_default(path: Path) -> None:
    img = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse(
        [STROKE_WIDTH, STROKE_WIDTH, CANVAS_SIZE - STROKE_WIDTH, CANVAS_SIZE - STROKE_WIDTH],
        fill=(33, 36, 46, 255),
    )

    cx = CANVAS_SIZE / 2
    cy = CANVAS_SIZE / 2
    r = ACCENT_DIAMETER // 2
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(110, 205, 121, 255))
    img.save(path)


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    generate_template(ASSET_DIR / "trayTemplate.png")
    generate_default(ASSET_DIR / "tray.png")
    print(f"Generated tray icons under {ASSET_DIR}")


if __name__ == "__main__":
    main()
