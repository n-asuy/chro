import { beforeEach, describe, expect, it } from "vitest";
import { useCommandPaletteStore } from "./command-palette-store";

describe("useCommandPaletteStore", () => {
  beforeEach(() => {
    useCommandPaletteStore.setState({ open: false });
  });

  it("starts closed", () => {
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("openPalette opens the modal (what the ⌘K / ⌘P shortcut calls)", () => {
    useCommandPaletteStore.getState().openPalette();
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });

  it("setOpen drives the Radix dialog's onOpenChange both ways", () => {
    useCommandPaletteStore.getState().setOpen(true);
    expect(useCommandPaletteStore.getState().open).toBe(true);
    useCommandPaletteStore.getState().setOpen(false);
    expect(useCommandPaletteStore.getState().open).toBe(false);
  });

  it("openPalette is idempotent while already open", () => {
    useCommandPaletteStore.getState().openPalette();
    useCommandPaletteStore.getState().openPalette();
    expect(useCommandPaletteStore.getState().open).toBe(true);
  });
});
