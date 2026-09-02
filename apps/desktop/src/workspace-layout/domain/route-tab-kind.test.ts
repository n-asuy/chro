import type { StoredTask } from "@/session/types";
import { describe, expect, it } from "vitest";
import {
  inferKindFromLocation,
  pathFromKind,
  resolveSessionOpen,
  sessionTabKind,
} from "./route-tab-kind";

function task(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    id: "task-1",
    slug: "fix-login",
    project_id: "project-a",
    title: "Fix login",
    status: "todo",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    sort_order: 0,
    ...overrides,
  };
}

describe("sessionTabKind", () => {
  it("identifies a session by its slug when it has one", () => {
    expect(sessionTabKind(task())).toEqual({
      type: "session",
      taskId: "fix-login",
    });
  });

  it("falls back to the id for slugless sessions", () => {
    expect(sessionTabKind(task({ slug: null }))).toEqual({
      type: "session",
      taskId: "task-1",
    });
  });

  it("matches the kind the URL sync infers for the same session", () => {
    const kind = sessionTabKind(task());
    const path = pathFromKind(kind, "project-a");
    expect(path).not.toBeNull();
    // Same identity from both directions, so opening a row directly can never
    // spawn a second tab alongside the one a deep link would open.
    expect(inferKindFromLocation(path as string)).toEqual(kind);
  });
});

describe("resolveSessionOpen", () => {
  it("opens a session of the bound project as a tab, never through the URL", () => {
    // Regression: routing the click through `navigate()` made it a no-op
    // whenever the URL already pointed at this session — after its tab was
    // closed, or while a URL-less tab (diff, browser) held the focus. The
    // decision must not depend on the current location at all.
    expect(resolveSessionOpen(task(), "project-a")).toEqual({
      type: "tab",
      kind: { type: "session", taskId: "fix-login" },
    });
  });

  it("routes to another project so its layout binds before the tab opens", () => {
    expect(resolveSessionOpen(task(), "project-b")).toEqual({
      type: "navigate",
      taskId: "fix-login",
    });
  });

  it("routes when no project layout is bound yet", () => {
    expect(resolveSessionOpen(task(), null)).toEqual({
      type: "navigate",
      taskId: "fix-login",
    });
  });
});
