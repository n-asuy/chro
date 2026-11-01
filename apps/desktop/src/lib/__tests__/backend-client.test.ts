import { afterEach, describe, expect, it, vi } from "vitest";

import { backendUrl } from "../backend-client";

// The packaged webview is served from its own origin (tauri://localhost), so a
// server-relative path handed to <img src> would never reach the backend.
const runtimeAt = (url: string) =>
  vi.stubGlobal("window", {
    location: { origin: "tauri://localhost" },
    __CHRO_RUNTIME__: { backendUrl: url },
  });

describe("backendUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a server-relative path against the runtime backend", () => {
    runtimeAt("http://127.0.0.1:4310/");
    expect(backendUrl("/rpc/images/abc/file")).toBe(
      "http://127.0.0.1:4310/rpc/images/abc/file",
    );
  });

  it("leaves an absolute URL untouched", () => {
    runtimeAt("http://127.0.0.1:4310");
    expect(backendUrl("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
  });
});
