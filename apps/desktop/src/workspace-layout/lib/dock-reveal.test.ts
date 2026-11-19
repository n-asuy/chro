import { describe, expect, it } from "vitest";
import { isDockRevealRequest } from "./dock-reveal";

const closed = {
  projectId: "p",
  hydrated: true,
  width: 280,
  collapsed: true,
  activePanel: null as string | null,
};
const open = { ...closed, collapsed: false, activePanel: "filetree" };

describe("isDockRevealRequest", () => {
  it("treats opening a closed dock as a request to see it", () => {
    expect(isDockRevealRequest(closed, open)).toBe(true);
  });

  it("treats re-selecting the already open panel as a request to see it", () => {
    expect(isDockRevealRequest(open, { ...open })).toBe(true);
  });

  it("treats switching panels as a request to see the dock", () => {
    expect(isDockRevealRequest(open, { ...open, activePanel: "search" })).toBe(
      true,
    );
  });

  it("ignores closing the dock", () => {
    expect(isDockRevealRequest(open, closed)).toBe(false);
  });

  it("ignores resizing", () => {
    expect(isDockRevealRequest(open, { ...open, width: 320 })).toBe(false);
  });

  it("ignores hydration and project rebinding", () => {
    expect(
      isDockRevealRequest({ ...closed, hydrated: false, projectId: null }, open),
    ).toBe(false);
    expect(isDockRevealRequest(open, { ...open, projectId: "q" })).toBe(false);
  });

  it("ignores a notification that carries no change", () => {
    expect(isDockRevealRequest(open, open)).toBe(false);
  });
});
