// @vitest-environment jsdom
import type { TranslationKey } from "@/i18n";
import en from "@/i18n/locales/en";
import ja from "@/i18n/locales/ja";
import { desktopFetch } from "@/lib/backend-client";
import { useCloudAccessStore } from "@/lib/cloud-access-store";
import { useFeatureFlagStore } from "@/lib/feature-flags-store";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BetaFeaturesSection } from "../beta-features-section";

let locale = en;
vi.mock("@/i18n", () => ({
  useLanguage: () => ({ t: (key: TranslationKey) => locale[key] }),
}));
vi.mock("@/lib/backend-client", () => ({ desktopFetch: vi.fn() }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  useFeatureFlagStore.setState({ optedIn: [], optedOut: [], devOverrides: {} });
  useCloudAccessStore.setState({
    signedIn: false,
    busy: false,
    signingOut: false,
    configured: true,
    email: null,
    signInUrl: null,
    error: null,
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.resetAllMocks();
});
describe.each([
  ["en", en],
  ["ja", ja],
] as const)("cloud settings (%s)", (_language, dictionary) => {
  async function render() {
    locale = dictionary;
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<BetaFeaturesSection />));
    return host;
  }
  const toggle = (host: HTMLElement) =>
    host.querySelector<HTMLButtonElement>(
      `[role="switch"][aria-label="${locale.cloudSignInTitle}"]`,
    );
  it("starts the shared flow, shows the link, and signs out", async () => {
    const host = await render();
    expect(host.textContent).toContain(locale.cloudSignInDescription);
    expect(toggle(host)?.getAttribute("aria-checked")).toBe("false");
    vi.mocked(desktopFetch)
      .mockResolvedValueOnce({ started: true })
      .mockResolvedValueOnce({
        configured: true,
        signed_in: false,
        busy: true,
        sign_in_url: "http://localhost/sign-in",
        email: null,
        error: null,
      });
    await act(async () => toggle(host)?.click());
    expect(toggle(host)?.disabled).toBe(true);
    expect(host.textContent).toContain(locale.cloudContinueInBrowser);
    expect(host.textContent).toContain(locale.cloudCopySignInLink);
    vi.mocked(desktopFetch).mockResolvedValueOnce({
      configured: true,
      signed_in: true,
      busy: false,
      email: "developer@example.test",
      error: null,
    });
    await act(async () => useCloudAccessStore.getState().refresh());
    expect(host.textContent).toContain("developer@example.test");
    expect(toggle(host)?.getAttribute("aria-checked")).toBe("true");
    expect(desktopFetch).toHaveBeenCalledWith("/rpc/cloud/login", {
      method: "POST",
    });
    vi.mocked(desktopFetch).mockResolvedValueOnce({ signed_in: false });
    await act(async () => toggle(host)?.click());
    expect(toggle(host)?.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).not.toContain("developer@example.test");
    expect(desktopFetch).toHaveBeenCalledWith("/rpc/cloud/logout", {
      method: "POST",
    });
  });
  it.each([
    ["not_allowed", "cloudAccountRefused"],
    ["unreachable", "cloudSignInUnreachable"],
    ["timed_out", "cloudSignInTimeout"],
    ["cancelled", "cloudSignInCancelled"],
  ] as const)("localizes %s independently", async (error, key) => {
    const host = await render();
    vi.mocked(desktopFetch).mockResolvedValueOnce({
      configured: true,
      signed_in: false,
      busy: false,
      error,
    });
    await act(async () => useCloudAccessStore.getState().refresh());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(locale[key]);
    expect(toggle(host)?.getAttribute("aria-checked")).toBe("false");
  });
  it("explains a sign-in that could not start in an unconfigured build", async () => {
    const host = await render();
    vi.mocked(desktopFetch)
      .mockRejectedValueOnce(new Error("Cloud is not configured"))
      .mockResolvedValueOnce({
        configured: false,
        signed_in: false,
        busy: false,
        error: "not_configured",
      });
    await act(async () => useCloudAccessStore.getState().signIn());
    expect(host.textContent).toContain(locale.cloudUnavailable);
    expect(toggle(host)).toBeNull();
  });
  it("offers no sign-in in an unconfigured build", async () => {
    const host = await render();
    await act(async () =>
      useCloudAccessStore.setState({ configured: false, error: null }),
    );
    expect(host.textContent).toContain(locale.cloudUnavailable);
    expect(toggle(host)).toBeNull();
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => button.textContent === locale.cloudSignIn,
      ),
    ).toBe(false);
  });
  it("a network error does not claim the account was refused", async () => {
    const host = await render();
    vi.mocked(desktopFetch)
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce(new Error("Failed to fetch"));
    await act(async () => toggle(host)?.click());
    expect(host.textContent).toContain(locale.cloudSignInUnreachable);
    expect(host.textContent).not.toContain(locale.cloudAccountRefused);
  });
  it("distinguishes an unreachable local server from an unavailable build", async () => {
    const host = await render();
    await act(async () => useCloudAccessStore.setState({ configured: null }));
    vi.mocked(desktopFetch).mockRejectedValueOnce(new Error("Failed to fetch"));
    await act(async () => useCloudAccessStore.getState().refresh());
    expect(host.textContent).toContain(locale.cloudSignInUnreachable);
    expect(host.textContent).toContain(locale.cloudRetryConnection);
    expect(host.textContent).not.toContain(locale.cloudUnavailable);
  });
  it("does not label a keychain failure as an account or network refusal", async () => {
    const host = await render();
    vi.mocked(desktopFetch)
      .mockRejectedValueOnce(
        new Error("Cannot save cloud sign-in in OS keychain"),
      )
      .mockResolvedValueOnce({
        configured: true,
        signed_in: false,
        busy: false,
        error: null,
      });
    await act(async () => toggle(host)?.click());
    expect(host.textContent).toContain(locale.cloudSignInFailed);
    expect(host.textContent).not.toContain(locale.cloudAccountRefused);
  });
  it("cancels and ignores a late login response", async () => {
    const host = await render();
    let finish!: (value: unknown) => void;
    vi.mocked(desktopFetch).mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    await act(async () => toggle(host)?.click());
    vi.mocked(desktopFetch).mockResolvedValueOnce({});
    await act(async () => useCloudAccessStore.getState().cancel());
    await act(async () => finish({ started: true }));
    expect(host.textContent).toContain(locale.cloudSignInCancelled);
    expect(toggle(host)?.getAttribute("aria-checked")).toBe("false");
    expect(desktopFetch).toHaveBeenCalledWith("/rpc/cloud/cancel", {
      method: "POST",
    });
  });
  it("hides cloud when a saved token expires, including developer overrides", async () => {
    const host = await render();
    await act(async () => {
      useFeatureFlagStore.setState({
        optedIn: ["cloud_sessions"],
        devOverrides: { cloud_sessions: true },
      });
      useCloudAccessStore.setState({ signedIn: true });
    });
    expect(toggle(host)?.getAttribute("aria-checked")).toBe("true");
    vi.mocked(desktopFetch).mockResolvedValueOnce({
      configured: true,
      signed_in: false,
      busy: false,
      error: null,
    });
    await act(async () => useCloudAccessStore.getState().refresh());
    expect(toggle(host)?.getAttribute("aria-checked")).toBe("false");
    expect(useFeatureFlagStore.getState().optedIn).not.toContain(
      "cloud_sessions",
    );
  });
});
