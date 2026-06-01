import { describe, expect, it } from "vitest";

import { shouldAdoptProject } from "../terminal-pane";

describe("shouldAdoptProject", () => {
  it("adopts when a not-yet-claimed shell learns its project cwd", () => {
    // A shell opened before the project UUID resolved — recycle it so it
    // restarts in the project directory.
    expect(shouldAdoptProject(null, "proj-a")).toBe(true);
  });

  it("does not restart while the resolved project is still unknown", () => {
    expect(shouldAdoptProject(null, null)).toBe(false);
    expect(shouldAdoptProject("proj-a", null)).toBe(false);
  });

  it("does not restart a session that already belongs to its project", () => {
    expect(shouldAdoptProject("proj-a", "proj-a")).toBe(false);
  });

  it("does NOT restart on the transient projectId flip during a project switch", () => {
    // Regression: switching project A → B re-runs the still-mounted A terminal
    // pane's effect with B's id before the layout unmounts it. A tab never
    // migrates between projects, so this must not fire — otherwise A's live PTY
    // (and its history) is killed the moment you switch away.
    expect(shouldAdoptProject("proj-a", "proj-b")).toBe(false);
  });
});
