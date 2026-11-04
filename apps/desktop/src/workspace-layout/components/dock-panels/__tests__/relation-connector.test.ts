import { describe, expect, it } from "vitest";
import { connectorPath } from "../relation-connector";

describe("connectorPath", () => {
  it("bends a spine into the first and last rows and branches into the rest", () => {
    const d = connectorPath(
      [
        { x: 30, y: 100 },
        { x: 20, y: 10 },
        { x: 20, y: 50 },
      ],
      { spineX: 4, radius: 6 },
    );
    expect(d).toBe(
      [
        "M 20 10 H 10 Q 4 10 4 16",
        "V 94 Q 4 100 10 100 H 30",
        "M 4 50 H 20",
      ].join(" "),
    );
  });

  it("shrinks the bends so two adjacent rows still join cleanly", () => {
    expect(
      connectorPath(
        [
          { x: 20, y: 10 },
          { x: 20, y: 18 },
        ],
        { spineX: 4, radius: 6 },
      ),
    ).toBe("M 20 10 H 8 Q 4 10 4 14 V 14 Q 4 18 8 18 H 20");
  });

  it("draws nothing for fewer than two rows: there is nothing to connect", () => {
    expect(connectorPath([], { spineX: 4, radius: 6 })).toBe("");
    expect(connectorPath([{ x: 20, y: 10 }], { spineX: 4, radius: 6 })).toBe(
      "",
    );
  });
});
