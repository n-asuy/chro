import { describe, expect, it } from "vitest";
import {
  CAPTURE_START,
  askPlacement,
  drag,
  finishPick,
  rectBetween,
  sendAsk,
  sendFailed,
  setAsk,
} from "./capture";

const rect = { x: 100, y: 80, width: 200, height: 120 };

describe("picking a region", () => {
  it("measures a drag in either direction", () => {
    expect(rectBetween({ x: 300, y: 200 }, { x: 100, y: 80 })).toEqual(rect);
  });

  it("follows the drag, then asks about the region", () => {
    const dragging = drag(CAPTURE_START, rect);
    expect(dragging).toEqual({ phase: "picking", dragging: rect });
    expect(finishPick(dragging, rect)).toEqual({
      phase: "asking",
      rect,
      text: "",
    });
  });

  it("a click (or a sliver) cancels instead of asking", () => {
    expect(finishPick(CAPTURE_START, { ...rect, width: 3 })).toBe("cancel");
    expect(finishPick(CAPTURE_START, { ...rect, height: 7 })).toBe("cancel");
  });
});

describe("asking", () => {
  const asking = finishPick(CAPTURE_START, rect);
  if (asking === "cancel") throw new Error("unreachable");

  it("sends only with something said", () => {
    expect(sendAsk(asking)).toBeNull();
    expect(sendAsk(setAsk(asking, "  "))).toBeNull();
    expect(sendAsk(setAsk(asking, "why is this red?"))).toEqual({
      phase: "sending",
      rect,
      text: "why is this red?",
    });
  });

  it("a failed send goes back to asking with the text kept", () => {
    const sending = sendAsk(setAsk(asking, "fix this"));
    if (!sending) throw new Error("unreachable");
    expect(sendFailed(sending)).toEqual({
      phase: "asking",
      rect,
      text: "fix this",
    });
  });

  it("places the ask pill under the region, inside the screen", () => {
    const screen = { width: 1440, height: 900 };
    expect(askPlacement(rect, screen)).toEqual({ left: 35, top: 214 });
    expect(
      askPlacement({ x: 1300, y: 850, width: 100, height: 40 }, screen),
    ).toEqual({
      left: 1098,
      top: 810,
    });
  });
});
