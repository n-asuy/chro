import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CapsuleDot } from "../domain/capsule-dots";

const uiState = vi.hoisted(() => ({
  ready: false,
  database: null as string | null,
  values: {} as Record<string, unknown>,
}));

vi.mock("@/lib/ui-state-client", () => ({
  isUiStateReady: () => uiState.ready,
  getUiDatabase: () => uiState.database,
  getUiValue: (key: string) => uiState.values[key] ?? null,
  setUiValue: (key: string, value: unknown) => {
    uiState.values[key] = value;
  },
}));

import { capsuleSlotsKey, useCapsuleSlotsStore } from "./capsule-slots-store";

const store = () => useCapsuleSlotsStore.getState();

function dot(id: string, status: CapsuleDot["status"]): CapsuleDot {
  const at = "2026-11-23T10:00:00Z";
  return {
    task: {
      id,
      project_id: "p",
      title: id,
      status: "completed",
      awaiting_input: false,
      active_session_id: status === "running" ? "s" : null,
      created_at: at,
      updated_at: at,
      sort_order: 0,
    },
    status,
    viewedAt: null,
  };
}

/** A new app launch: the store starts empty, UI state is what was saved. */
function launch(database: string | null) {
  uiState.ready = true;
  uiState.database = database;
  useCapsuleSlotsStore.setState(useCapsuleSlotsStore.getInitialState(), true);
  store().hydrate();
}

describe("useCapsuleSlotsStore", () => {
  beforeEach(() => {
    uiState.ready = false;
    uiState.values = {};
    useCapsuleSlotsStore.setState(useCapsuleSlotsStore.getInitialState(), true);
  });

  it("decides nothing before the stored order is known", () => {
    expect(store().hydrate()).toBe(false);
    store().advance([dot("a", "done")], false);
    expect(store().edge).toBeNull();
    expect(uiState.values).toEqual({});
  });

  it("stores the order and restores it on the next launch", () => {
    launch("db1");
    store().advance([dot("a", "idle"), dot("b", "running")], false);
    expect(store().edge?.slots).toEqual(["b", "a"]);
    launch("db1");
    expect(store().edge?.slots).toEqual(["b", "a"]);
    store().advance([dot("a", "running"), dot("b", "idle")], false);
    expect(store().edge?.slots).toEqual(["b", "a"]);
  });

  it("writes only when the order changes", () => {
    launch("db1");
    store().advance([dot("a", "done")], false);
    uiState.values = {};
    store().advance([dot("a", "idle")], false);
    expect(uiState.values).toEqual({});
  });

  it("keeps one order per database", () => {
    launch("db1");
    store().advance([dot("a", "done")], false);
    launch("db2");
    expect(store().edge).toBeNull();
    store().advance([dot("z", "done")], false);
    expect(uiState.values).toEqual({
      [capsuleSlotsKey("db1")]: { slots: ["a"], line: {} },
      [capsuleSlotsKey("db2")]: { slots: ["z"], line: {} },
    });
  });

  it("holds the order without storing it when the database is unknown", () => {
    const saved = { slots: ["a"], line: {} };
    uiState.values[capsuleSlotsKey("db1")] = saved;
    launch(null);
    store().advance([dot("z", "done")], false);
    expect(store().edge?.slots).toEqual(["z"]);
    expect(uiState.values).toEqual({ [capsuleSlotsKey("db1")]: saved });
  });

  it("stores the frozen removal of a session that is gone", () => {
    launch("db1");
    store().advance([dot("a", "done"), dot("b", "running")], false);
    store().advance([dot("a", "done"), dot("c", "done")], true);
    expect(store().edge?.slots).toEqual(["a"]);
    expect(uiState.values[capsuleSlotsKey("db1")]).toEqual({
      slots: ["a"],
      line: {},
    });
  });
});
