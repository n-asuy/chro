import { describe, expect, it } from "vitest";

import {
  collapseLabel,
  describeKeyCombo,
  formatElementPath,
  pickLabel,
} from "../dev-autocapture";

/** Minimal stand-in: only the fields the combo logic reads. */
function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "a",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("describeKeyCombo", () => {
  it("ignores plain typing so the log never becomes a transcript", () => {
    expect(describeKeyCombo(keyEvent({ key: "a" }))).toBeNull();
    expect(describeKeyCombo(keyEvent({ key: "A", shiftKey: true }))).toBeNull();
    expect(describeKeyCombo(keyEvent({ key: " " }))).toBeNull();
  });

  it("records shortcuts with their modifiers", () => {
    expect(describeKeyCombo(keyEvent({ key: "k", metaKey: true }))).toBe(
      "meta+k",
    );
    expect(
      describeKeyCombo(keyEvent({ key: "P", metaKey: true, shiftKey: true })),
    ).toBe("meta+shift+p");
    expect(describeKeyCombo(keyEvent({ key: "Enter", metaKey: true }))).toBe(
      "meta+Enter",
    );
  });

  it("records navigation keys without a modifier", () => {
    expect(describeKeyCombo(keyEvent({ key: "Escape" }))).toBe("Escape");
    expect(describeKeyCombo(keyEvent({ key: "Tab" }))).toBe("Tab");
    expect(describeKeyCombo(keyEvent({ key: "ArrowDown" }))).toBe("ArrowDown");
  });

  it("ignores a modifier pressed on its own", () => {
    expect(
      describeKeyCombo(keyEvent({ key: "Meta", metaKey: true })),
    ).toBeNull();
    expect(
      describeKeyCombo(
        keyEvent({ key: "Shift", shiftKey: true, altKey: true }),
      ),
    ).toBeNull();
  });
});

describe("pickLabel", () => {
  it("prefers an explicit label over visible text", () => {
    expect(pickLabel({ ariaLabel: "Close", text: "×" })).toBe("Close");
    expect(pickLabel({ title: "Merge", text: "Merge branch" })).toBe("Merge");
  });

  it("falls back through text to placeholder", () => {
    expect(pickLabel({ text: "  Run   task \n" })).toBe("Run task");
    expect(pickLabel({ text: "   ", placeholder: "Search files" })).toBe(
      "Search files",
    );
  });

  it("returns undefined when there is nothing to name it by", () => {
    expect(pickLabel({})).toBeUndefined();
    expect(pickLabel({ ariaLabel: "", text: "\n\t " })).toBeUndefined();
  });

  it("truncates long text", () => {
    const label = collapseLabel("x".repeat(200));
    expect(label).toHaveLength(61);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("formatElementPath", () => {
  it("renders the chain root-first with ids", () => {
    expect(
      formatElementPath([
        { tag: "div", id: "root" },
        { tag: "main" },
        { tag: "button" },
      ]),
    ).toBe("div#root>main>button");
  });

  it("keeps the closest ancestors when the chain is deep", () => {
    const deep = [
      "html",
      "body",
      "div",
      "main",
      "section",
      "form",
      "button",
    ].map((tag) => ({ tag }));
    expect(formatElementPath(deep)).toBe("div>main>section>form>button");
  });
});
