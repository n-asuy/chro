import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlagView } from "./flags-client";

const mock = vi.hoisted(() => ({
  fetchFlagRegistry: vi.fn(),
}));

vi.mock("./flags-client", () => ({
  fetchFlagRegistry: mock.fetchFlagRegistry,
}));

// Two synthetic flags stand in for the generated registry so these tests keep
// passing as real flags come and go.
vi.mock("./flags.generated", () => ({
  FLAG_DEFAULTS: { flag_on_by_default: true, flag_off_by_default: false },
}));

const storage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

vi.stubGlobal("window", { localStorage: storage });

import {
  FLAG_OVERRIDES_STORAGE_KEY,
  readPersistedOverrides,
  selectFlag,
  useFeatureFlagStore,
} from "./feature-flags-store";

function flagView(key: string, overrides: Partial<FlagView> = {}): FlagView {
  return {
    key,
    owner: "@someone",
    created: "2026-01-01",
    retire_by: "2099-01-01",
    default_enabled: false,
    rollout: "local",
    status: "experimental",
    description: "",
    resolved_value: false,
    ...overrides,
  };
}

const flag = (key: string) => selectFlag(useFeatureFlagStore.getState(), key);

describe("useFeatureFlagStore", () => {
  beforeEach(() => {
    mock.fetchFlagRegistry.mockReset();
    storage.clear();
    useFeatureFlagStore.setState({
      registry: [],
      resolved: { flag_on_by_default: true, flag_off_by_default: false },
      overrides: {},
      loaded: false,
      loading: false,
    });
  });

  it("reads the compiled-in default before the registry loads", () => {
    // No fetch has happened yet. A default-on flag must not read as off, or the
    // gated UI flashes out and then back in once the registry arrives.
    expect(flag("flag_on_by_default")).toBe(true);
    expect(flag("flag_off_by_default")).toBe(false);
  });

  it("overlays server-resolved values onto the defaults", async () => {
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_on_by_default", { resolved_value: false }),
      flagView("flag_off_by_default", { resolved_value: true }),
    ]);

    await useFeatureFlagStore.getState().load();

    expect(flag("flag_on_by_default")).toBe(false);
    expect(flag("flag_off_by_default")).toBe(true);
    expect(useFeatureFlagStore.getState().loaded).toBe(true);
  });

  it("keeps the defaults when the registry cannot be fetched", async () => {
    mock.fetchFlagRegistry.mockRejectedValue(new Error("server down"));

    await useFeatureFlagStore.getState().load();

    // The Rust registry promises each flag's default on any resolve failure;
    // the renderer must not downgrade that promise to `false`.
    expect(flag("flag_on_by_default")).toBe(true);
    expect(flag("flag_off_by_default")).toBe(false);
    expect(useFeatureFlagStore.getState().loading).toBe(false);
  });

  it("lets a local override win over the resolved value", async () => {
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_off_by_default", { resolved_value: false }),
    ]);
    await useFeatureFlagStore.getState().load();

    useFeatureFlagStore.getState().setOverride("flag_off_by_default", true);

    expect(flag("flag_off_by_default")).toBe(true);
  });

  it("falls back to the resolved value when an override is cleared", async () => {
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_off_by_default", { resolved_value: true }),
    ]);
    await useFeatureFlagStore.getState().load();
    useFeatureFlagStore.getState().setOverride("flag_off_by_default", false);
    expect(flag("flag_off_by_default")).toBe(false);

    useFeatureFlagStore.getState().setOverride("flag_off_by_default", null);

    expect(flag("flag_off_by_default")).toBe(true);
    expect(useFeatureFlagStore.getState().overrides).toEqual({});
  });

  it("keeps overrides across a registry reload", async () => {
    useFeatureFlagStore.getState().setOverride("flag_off_by_default", true);
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_off_by_default", { resolved_value: false }),
    ]);

    await useFeatureFlagStore.getState().load();

    expect(flag("flag_off_by_default")).toBe(true);
  });

  it("clears every override at once", () => {
    useFeatureFlagStore.getState().setOverride("flag_off_by_default", true);
    useFeatureFlagStore.getState().setOverride("flag_on_by_default", false);

    useFeatureFlagStore.getState().clearOverrides();

    expect(useFeatureFlagStore.getState().overrides).toEqual({});
    expect(flag("flag_off_by_default")).toBe(false);
    expect(flag("flag_on_by_default")).toBe(true);
  });

  it("does not re-enter load while one is already in flight", async () => {
    mock.fetchFlagRegistry.mockResolvedValue([]);

    await Promise.all([
      useFeatureFlagStore.getState().load(),
      useFeatureFlagStore.getState().load(),
    ]);

    expect(mock.fetchFlagRegistry).toHaveBeenCalledTimes(1);
  });
});

describe("override persistence", () => {
  beforeEach(() => {
    storage.clear();
    useFeatureFlagStore.setState({ overrides: {} });
  });

  it("persists an override so a forced value survives a restart", () => {
    useFeatureFlagStore.getState().setOverride("flag_off_by_default", true);

    expect(readPersistedOverrides()).toEqual({ flag_off_by_default: true });
  });

  it("drops the persisted entry when an override is cleared", () => {
    useFeatureFlagStore.getState().setOverride("flag_off_by_default", true);

    useFeatureFlagStore.getState().setOverride("flag_off_by_default", null);

    expect(readPersistedOverrides()).toEqual({});
  });

  it("ignores unparsable persisted overrides", () => {
    storage.setItem(FLAG_OVERRIDES_STORAGE_KEY, "{not json");

    expect(readPersistedOverrides()).toEqual({});
  });

  it("ignores persisted entries that are not booleans", () => {
    storage.setItem(
      FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ good: true, bad: "yes", worse: null }),
    );

    expect(readPersistedOverrides()).toEqual({ good: true });
  });
});
