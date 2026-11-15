import { beforeEach, describe, expect, it, vi } from "vitest";

const uiState = vi.hoisted(() => ({
  ready: false,
  values: {} as Record<string, unknown>,
  setUiValue: vi.fn(),
}));

vi.mock("@/lib/ui-state-client", () => ({
  isUiStateReady: () => uiState.ready,
  getUiValue: (key: string) => uiState.values[key] ?? null,
  setUiValue: uiState.setUiValue,
}));

import {
  NEST_DELEGATIONS_KEY,
  useSessionListPreferencesStore,
} from "./session-list-preferences-store";

const store = () => useSessionListPreferencesStore.getState();

describe("useSessionListPreferencesStore", () => {
  beforeEach(() => {
    uiState.ready = false;
    uiState.values = {};
    uiState.setUiValue.mockReset();
    useSessionListPreferencesStore.setState({
      nestDelegations: false,
      hydrated: false,
    });
  });

  it("keeps the list flat until UI state says otherwise", () => {
    expect(store().hydrate()).toBe(false);
    expect(store().nestDelegations).toBe(false);
  });

  it("hydrates the persisted choice once UI state is ready", () => {
    uiState.ready = true;
    uiState.values[NEST_DELEGATIONS_KEY] = true;
    expect(store().hydrate()).toBe(true);
    expect(store().nestDelegations).toBe(true);
  });

  it("ignores a persisted value that is not a boolean", () => {
    uiState.ready = true;
    uiState.values[NEST_DELEGATIONS_KEY] = "yes";
    store().hydrate();
    expect(store().nestDelegations).toBe(false);
  });

  it("persists a change and lets it win over a later hydration", () => {
    store().setNestDelegations(true);
    expect(uiState.setUiValue).toHaveBeenCalledWith(NEST_DELEGATIONS_KEY, true);

    uiState.ready = true;
    uiState.values[NEST_DELEGATIONS_KEY] = false;
    store().hydrate();
    expect(store().nestDelegations).toBe(true);
  });
});
