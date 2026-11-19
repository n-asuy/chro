import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/flags-client", () => ({ fetchFlagRegistry: vi.fn() }));
vi.mock("@/lib/flags.generated", () => ({
  FLAG_DEFAULTS: { edge_toolbar: true },
  FLAG_OPT_IN: { edge_toolbar: true },
}));
vi.mock("./lib/edge-window-client", () => ({
  setEdgeToolbarEnabled: vi.fn(),
}));

const storage = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
});

import { useFeatureFlagStore } from "@/lib/feature-flags-store";
import { followEdgeToolbarFlag } from "./edge-toolbar-host";

describe("the edge toolbar beta switch", () => {
  beforeEach(() => {
    storage.clear();
    useFeatureFlagStore.setState({
      resolved: { edge_toolbar: true },
      optedOut: [],
      optedIn: [],
      devOverrides: {},
    });
  });

  it("keeps the window closed until the user turns the beta on", () => {
    const apply = vi.fn();
    const stop = followEdgeToolbarFlag(apply);
    expect(apply.mock.calls).toEqual([[false]]);
    stop();
  });

  it("creates the window when switched on and closes it when switched off", () => {
    const apply = vi.fn();
    const stop = followEdgeToolbarFlag(apply);
    const store = useFeatureFlagStore.getState();
    store.setBetaEnabled("edge_toolbar", true);
    store.setBetaEnabled("edge_toolbar", false);
    expect(apply.mock.calls).toEqual([[false], [true], [false]]);
    stop();
  });

  it("closes the window when the beta is withdrawn for everyone", () => {
    const apply = vi.fn();
    useFeatureFlagStore.getState().setBetaEnabled("edge_toolbar", true);
    const stop = followEdgeToolbarFlag(apply);
    useFeatureFlagStore.setState({ resolved: { edge_toolbar: false } });
    expect(apply.mock.calls).toEqual([[true], [false]]);
    stop();
  });

  it("does not repeat itself for unrelated store changes", () => {
    const apply = vi.fn();
    const stop = followEdgeToolbarFlag(apply);
    useFeatureFlagStore.setState({ loading: true });
    expect(apply).toHaveBeenCalledTimes(1);
    stop();
  });
});
