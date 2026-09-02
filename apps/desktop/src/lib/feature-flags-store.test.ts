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
  BETA_OPT_OUTS_STORAGE_KEY,
  DEV_FLAG_OVERRIDES_STORAGE_KEY,
  readPersistedDevOverrides,
  readPersistedOptOuts,
  selectFlag,
  useFeatureFlagStore,
} from "./feature-flags-store";

const flagView = (key: string, enabled: boolean): FlagView => ({
  key,
  enabled,
});

const flag = (key: string) => selectFlag(useFeatureFlagStore.getState(), key);

describe("useFeatureFlagStore", () => {
  beforeEach(() => {
    mock.fetchFlagRegistry.mockReset();
    storage.clear();
    useFeatureFlagStore.setState({
      resolved: { flag_on_by_default: true, flag_off_by_default: false },
      optedOut: [],
      devOverrides: {},
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
      flagView("flag_on_by_default", false),
      flagView("flag_off_by_default", true),
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

  it("lets the user switch an offered feature off", async () => {
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_off_by_default", true),
    ]);
    await useFeatureFlagStore.getState().load();

    useFeatureFlagStore.getState().setBetaEnabled("flag_off_by_default", false);

    expect(flag("flag_off_by_default")).toBe(false);
  });

  it("restores the resolved value when the user switches it back on", async () => {
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_off_by_default", true),
    ]);
    await useFeatureFlagStore.getState().load();
    useFeatureFlagStore.getState().setBetaEnabled("flag_off_by_default", false);
    expect(flag("flag_off_by_default")).toBe(false);

    useFeatureFlagStore.getState().setBetaEnabled("flag_off_by_default", true);

    expect(flag("flag_off_by_default")).toBe(true);
    expect(useFeatureFlagStore.getState().optedOut).toEqual([]);
  });

  it("cannot switch on a feature the backend resolved off", async () => {
    // The kill switch has to survive whatever is stored locally: a machine
    // that already switched the feature on must still lose it at 0%.
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_on_by_default", false),
    ]);
    await useFeatureFlagStore.getState().load();

    useFeatureFlagStore.getState().setBetaEnabled("flag_on_by_default", true);

    expect(flag("flag_on_by_default")).toBe(false);
  });

  it("keeps an opt-out across a registry reload", async () => {
    useFeatureFlagStore.getState().setBetaEnabled("flag_off_by_default", false);
    mock.fetchFlagRegistry.mockResolvedValue([
      flagView("flag_off_by_default", true),
    ]);

    await useFeatureFlagStore.getState().load();

    expect(flag("flag_off_by_default")).toBe(false);
  });

  it("does not record the same opt-out twice", () => {
    useFeatureFlagStore.getState().setBetaEnabled("flag_on_by_default", false);
    useFeatureFlagStore.getState().setBetaEnabled("flag_on_by_default", false);

    expect(useFeatureFlagStore.getState().optedOut).toEqual([
      "flag_on_by_default",
    ]);
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

describe("opt-out persistence", () => {
  beforeEach(() => {
    storage.clear();
    useFeatureFlagStore.setState({ optedOut: [] });
  });

  it("persists an opt-out so it survives a restart", () => {
    useFeatureFlagStore.getState().setBetaEnabled("flag_off_by_default", false);

    expect(readPersistedOptOuts()).toEqual(["flag_off_by_default"]);
  });

  it("drops the persisted entry when the feature is switched back on", () => {
    useFeatureFlagStore.getState().setBetaEnabled("flag_off_by_default", false);

    useFeatureFlagStore.getState().setBetaEnabled("flag_off_by_default", true);

    expect(readPersistedOptOuts()).toEqual([]);
  });

  it("ignores unparsable persisted opt-outs", () => {
    storage.setItem(BETA_OPT_OUTS_STORAGE_KEY, "{not json");

    expect(readPersistedOptOuts()).toEqual([]);
  });

  it("ignores persisted entries that are not strings", () => {
    storage.setItem(
      BETA_OPT_OUTS_STORAGE_KEY,
      JSON.stringify(["good", 3, null, { key: "bad" }]),
    );

    expect(readPersistedOptOuts()).toEqual(["good"]);
  });

  it("ignores a persisted value that is not a list", () => {
    // The previous format was an object of forced values; it must not be read
    // back as opt-outs, which would silently invert what the user chose.
    storage.setItem(
      BETA_OPT_OUTS_STORAGE_KEY,
      JSON.stringify({ flag_off_by_default: true }),
    );

    expect(readPersistedOptOuts()).toEqual([]);
  });
});

// Vitest runs with `import.meta.env.DEV` true, which is exactly the build
// this layer exists in; release builds compile it to a no-op.
describe("dev overrides (dev builds only)", () => {
  beforeEach(() => {
    storage.clear();
    useFeatureFlagStore.setState({
      resolved: { flag_on_by_default: true, flag_off_by_default: false },
      optedOut: [],
      devOverrides: {},
    });
  });

  it("forces on a flag the backend resolved off", () => {
    useFeatureFlagStore.getState().setDevOverride("flag_off_by_default", true);

    expect(flag("flag_off_by_default")).toBe(true);
  });

  it("outranks a user opt-out", () => {
    useFeatureFlagStore.getState().setBetaEnabled("flag_on_by_default", false);
    useFeatureFlagStore.getState().setDevOverride("flag_on_by_default", true);

    expect(flag("flag_on_by_default")).toBe(true);
  });

  it("returns to normal precedence when unforced", () => {
    useFeatureFlagStore.getState().setDevOverride("flag_off_by_default", true);

    useFeatureFlagStore.getState().setDevOverride("flag_off_by_default", null);

    expect(flag("flag_off_by_default")).toBe(false);
  });

  it("clears every force at once", () => {
    useFeatureFlagStore.getState().setDevOverride("flag_off_by_default", true);
    useFeatureFlagStore.getState().setDevOverride("flag_on_by_default", false);

    useFeatureFlagStore.getState().clearDevOverrides();

    expect(useFeatureFlagStore.getState().devOverrides).toEqual({});
    expect(flag("flag_off_by_default")).toBe(false);
    expect(flag("flag_on_by_default")).toBe(true);
  });

  it("persists forces so they survive a reload", () => {
    useFeatureFlagStore.getState().setDevOverride("flag_off_by_default", true);

    expect(readPersistedDevOverrides()).toEqual({ flag_off_by_default: true });
  });

  it("ignores persisted entries that are not booleans", () => {
    storage.setItem(
      DEV_FLAG_OVERRIDES_STORAGE_KEY,
      JSON.stringify({ good: false, bad: "yes" }),
    );

    expect(readPersistedDevOverrides()).toEqual({ good: false });
  });
});
