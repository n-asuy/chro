import type { AppearanceConfig } from "@/lib/preferences-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  fetchAppearanceConfig: vi.fn(),
  saveAppearanceConfig: vi.fn(),
}));

vi.mock("@/lib/preferences-client", () => ({
  DEFAULT_APPEARANCE_CONFIG: { theme: "system" } as AppearanceConfig,
  fetchAppearanceConfig: mock.fetchAppearanceConfig,
  saveAppearanceConfig: mock.saveAppearanceConfig,
}));

import { useAppearanceConfigStore } from "./appearance-store";

function resetStore(config: AppearanceConfig = { theme: "system" }) {
  useAppearanceConfigStore.setState({ config, loaded: false, loading: false });
}

describe("useAppearanceConfigStore", () => {
  beforeEach(() => {
    mock.fetchAppearanceConfig.mockReset();
    mock.saveAppearanceConfig.mockReset();
    resetStore();
  });

  it("optimistically applies an accent, then reconciles to the server echo", async () => {
    mock.saveAppearanceConfig.mockResolvedValue({
      appearance: { theme: "system", accent: "#7c3aed" },
    });

    const pending = useAppearanceConfigStore
      .getState()
      .update({ accent: "#7C3AED" });

    // Optimistic value is visible before the save resolves.
    expect(useAppearanceConfigStore.getState().config.accent).toBe("#7C3AED");
    await pending;

    // Reconciled to the server's normalized echo.
    expect(useAppearanceConfigStore.getState().config.accent).toBe("#7c3aed");
    expect(mock.saveAppearanceConfig).toHaveBeenCalledWith({
      accent: "#7C3AED",
    });
  });

  it("rolls back to the previous config when the save fails", async () => {
    resetStore({ theme: "dark", accent: "#0c6cbe" });
    mock.saveAppearanceConfig.mockRejectedValue(new Error("network down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await useAppearanceConfigStore.getState().update({ accent: "#ff0000" });

    expect(useAppearanceConfigStore.getState().config.accent).toBe("#0c6cbe");
    errorSpy.mockRestore();
  });

  it("clears the accent when reset to null", async () => {
    resetStore({ theme: "system", accent: "#7c3aed" });
    mock.saveAppearanceConfig.mockResolvedValue({
      appearance: { theme: "system", accent: null },
    });

    await useAppearanceConfigStore.getState().update({ accent: null });

    expect(mock.saveAppearanceConfig).toHaveBeenCalledWith({ accent: null });
    expect(useAppearanceConfigStore.getState().config.accent).toBeNull();
  });

  it("is a no-op when the value is unchanged (no save, no fresh object)", async () => {
    const before = useAppearanceConfigStore.getState().config;

    await useAppearanceConfigStore.getState().update({ theme: "system" });

    expect(mock.saveAppearanceConfig).not.toHaveBeenCalled();
    // Same object reference: no churn that could loop a config-keyed effect.
    expect(useAppearanceConfigStore.getState().config).toBe(before);
  });

  it("ignores a stale save echo when a newer update supersedes it", async () => {
    let resolveSlow: (value: { appearance: AppearanceConfig }) => void =
      () => {};
    mock.saveAppearanceConfig
      .mockImplementationOnce(
        () =>
          new Promise<{ appearance: AppearanceConfig }>((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce({
        appearance: { theme: "system", accent: "#222222" },
      });

    const slow = useAppearanceConfigStore
      .getState()
      .update({ accent: "#111111" });
    const fast = useAppearanceConfigStore
      .getState()
      .update({ accent: "#222222" });
    await fast;

    expect(useAppearanceConfigStore.getState().config.accent).toBe("#222222");

    // The first (slow) save now echoes the older value, out of order.
    resolveSlow({ appearance: { theme: "system", accent: "#111111" } });
    await slow;

    // The stale echo must not overwrite the newer accent.
    expect(useAppearanceConfigStore.getState().config.accent).toBe("#222222");
  });
});
