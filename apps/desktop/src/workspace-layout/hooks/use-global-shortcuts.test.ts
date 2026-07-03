import { describe, expect, it } from "vitest";
import { matchGlobalShortcut } from "./use-global-shortcuts";

type Combo = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

const event = (combo: Combo) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...combo,
});

describe("matchGlobalShortcut", () => {
  it("maps ⌘K and ⌘P to the session-search palette", () => {
    expect(matchGlobalShortcut(event({ key: "k", metaKey: true }))).toBe(
      "palette",
    );
    expect(matchGlobalShortcut(event({ key: "p", metaKey: true }))).toBe(
      "palette",
    );
  });

  it("maps ⌘N to new chat", () => {
    expect(matchGlobalShortcut(event({ key: "n", metaKey: true }))).toBe(
      "new-chat",
    );
    expect(matchGlobalShortcut(event({ key: "N", ctrlKey: true }))).toBe(
      "new-chat",
    );
  });

  it("maps ⌘⇧F to file search", () => {
    expect(
      matchGlobalShortcut(event({ key: "f", metaKey: true, shiftKey: true })),
    ).toBe("file-search");
    expect(
      matchGlobalShortcut(event({ key: "F", ctrlKey: true, shiftKey: true })),
    ).toBe("file-search");
  });

  it("treats Ctrl as ⌘ for non-mac keyboards", () => {
    expect(matchGlobalShortcut(event({ key: "k", ctrlKey: true }))).toBe(
      "palette",
    );
  });

  it("no longer maps ⌘O to any action", () => {
    expect(matchGlobalShortcut(event({ key: "o", metaKey: true }))).toBeNull();
  });

  it("does not fire the palette or new chat when Shift is held", () => {
    expect(
      matchGlobalShortcut(event({ key: "k", metaKey: true, shiftKey: true })),
    ).toBeNull();
    expect(
      matchGlobalShortcut(event({ key: "n", metaKey: true, shiftKey: true })),
    ).toBeNull();
  });

  it("requires ⌘F to be Shift-modified (plain ⌘F is in-page find)", () => {
    expect(matchGlobalShortcut(event({ key: "f", metaKey: true }))).toBeNull();
  });

  it("ignores plain keypresses without a meta/ctrl modifier", () => {
    expect(matchGlobalShortcut(event({ key: "n" }))).toBeNull();
    expect(matchGlobalShortcut(event({ key: "k" }))).toBeNull();
  });

  it("ignores combos that also hold Alt", () => {
    expect(
      matchGlobalShortcut(event({ key: "n", metaKey: true, altKey: true })),
    ).toBeNull();
    expect(
      matchGlobalShortcut(
        event({ key: "f", metaKey: true, shiftKey: true, altKey: true }),
      ),
    ).toBeNull();
  });
});
