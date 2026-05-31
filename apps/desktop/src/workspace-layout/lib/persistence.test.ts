import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DockState } from "../types";

const uiStateMock = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    setUiValue: vi.fn((key: string, value: unknown) => {
      values.set(key, value);
    }),
  };
});

vi.mock("@/lib/ui-state-client", () => ({
  getUiValue: vi.fn((key: string) => uiStateMock.values.get(key) ?? null),
  setUiValue: vi.fn((key: string, value: unknown) => {
    uiStateMock.setUiValue(key, value);
  }),
}));

import {
  loadDock,
  loadRightDock,
  saveDock,
  saveRightDock,
} from "./persistence";

const GLOBAL_DOCK_KEY = "workspace-layout:dock:v1";
const GLOBAL_RIGHT_DOCK_KEY = "workspace-layout:right-dock:v1";

function dock(width: number): DockState {
  return {
    activePanel: "projects",
    width,
    collapsed: false,
  };
}

function rightDock(width: number): DockState {
  return {
    activePanel: "filetree",
    width,
    collapsed: false,
  };
}

function persistedDock(width: number) {
  return {
    version: 1,
    dock: dock(width),
  };
}

function persistedRightDock(width: number) {
  return {
    version: 1,
    dock: rightDock(width),
  };
}

describe("workspace layout persistence", () => {
  beforeEach(() => {
    uiStateMock.values.clear();
    uiStateMock.setUiValue.mockClear();
  });

  it("persists left dock state without scoping it to a project", () => {
    saveDock(dock(344));

    expect([...uiStateMock.values.keys()]).toEqual([GLOBAL_DOCK_KEY]);
    expect(uiStateMock.values.get(GLOBAL_DOCK_KEY)).toEqual(persistedDock(344));
  });

  it("prefers the global left dock state over legacy project-scoped state", () => {
    uiStateMock.values.set(GLOBAL_DOCK_KEY, persistedDock(344));
    uiStateMock.values.set(
      "workspace-layout:dock:v1:project-a",
      persistedDock(220),
    );

    expect(loadDock("project-a")).toEqual(dock(344));
  });

  it("can read legacy project-scoped left dock state as a migration source", () => {
    uiStateMock.values.set(
      "workspace-layout:dock:v1:project-a",
      persistedDock(220),
    );

    expect(loadDock("project-a")).toEqual(dock(220));
    expect(loadDock("project-b")).toBeNull();
  });

  it("persists right dock state without scoping it to a project", () => {
    saveRightDock(rightDock(360));

    expect([...uiStateMock.values.keys()]).toEqual([GLOBAL_RIGHT_DOCK_KEY]);
    expect(uiStateMock.values.get(GLOBAL_RIGHT_DOCK_KEY)).toEqual(
      persistedRightDock(360),
    );
  });

  it("prefers the global right dock state over legacy project-scoped state", () => {
    uiStateMock.values.set(GLOBAL_RIGHT_DOCK_KEY, persistedRightDock(360));
    uiStateMock.values.set(
      "workspace-layout:right-dock:v1:project-a",
      persistedRightDock(240),
    );

    expect(loadRightDock("project-a")).toEqual(rightDock(360));
  });

  it("can read legacy project-scoped right dock state as a migration source", () => {
    uiStateMock.values.set(
      "workspace-layout:right-dock:v1:project-a",
      persistedRightDock(240),
    );

    expect(loadRightDock("project-a")).toEqual(rightDock(240));
    expect(loadRightDock("project-b")).toBeNull();
  });
});
