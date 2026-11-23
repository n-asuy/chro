import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ desktopFetch: vi.fn() }));
vi.mock("./backend-client", () => ({
  desktopFetch: backend.desktopFetch,
  getBackendBaseUrl: () => "http://127.0.0.1:1",
}));

describe("getUiDatabase", () => {
  beforeEach(() => {
    vi.resetModules();
    backend.desktopFetch.mockReset();
  });

  it("names the server's database once UI state is loaded", async () => {
    backend.desktopFetch.mockResolvedValue({ ui_state: {}, database: "db1" });
    const { getUiDatabase, loadUiState } = await import("./ui-state-client");
    expect(getUiDatabase()).toBeNull();
    await loadUiState();
    expect(getUiDatabase()).toBe("db1");
  });

  it("stays unknown when the load fails, so nothing is stored over it", async () => {
    backend.desktopFetch.mockRejectedValue(new Error("offline"));
    const { getUiDatabase, isUiStateReady, loadUiState } = await import(
      "./ui-state-client"
    );
    await loadUiState();
    expect(isUiStateReady()).toBe(true);
    expect(getUiDatabase()).toBeNull();
  });

  it("stays unknown against a server that does not name it", async () => {
    backend.desktopFetch.mockResolvedValue({ ui_state: {} });
    const { getUiDatabase, loadUiState } = await import("./ui-state-client");
    await loadUiState();
    expect(getUiDatabase()).toBeNull();
  });
});
