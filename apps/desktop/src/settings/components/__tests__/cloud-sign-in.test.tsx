// @vitest-environment jsdom
import type { TranslationKey } from "@/i18n";
import en from "@/i18n/locales/en";
import ja from "@/i18n/locales/ja";
import { desktopFetch } from "@/lib/backend-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BetaFeaturesSection } from "../beta-features-section";

let locale = en;
vi.mock("@/i18n", () => ({
  useLanguage: () => ({ t: (key: TranslationKey) => locale[key] }),
}));
vi.mock("@/lib/backend-client", () => ({ desktopFetch: vi.fn() }));
vi.mock("@/lib/feature-flags-store", () => ({
  useFlag: (key: string) => key === "cloud_sessions",
  useFeatureFlagStore: (select: (state: unknown) => unknown) =>
    select({ resolved: {} }),
}));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
let root: ReturnType<typeof createRoot>;
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
  it("localizes the row, pending state and successful sign-in", async () => {
    const host = await render();
    expect(host.textContent).toContain(locale.cloudSignInTitle);
    expect(host.textContent).toContain(locale.cloudSignInDescription);
    expect(host.querySelector("button")?.textContent).toBe(locale.cloudSignIn);
    let resolve!: (value: unknown) => void;
    vi.mocked(desktopFetch).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => host.querySelector("button")?.click());
    expect(host.querySelector("button")?.textContent).toBe(
      locale.cloudSigningIn,
    );
    await act(async () => resolve({}));
    expect(host.textContent).toContain(locale.cloudSignedIn);
  });
  it("localizes errors instead of displaying the server's English message", async () => {
    const host = await render();
    vi.mocked(desktopFetch).mockRejectedValueOnce(
      new Error("Cloud sign-in expired. Sign in again."),
    );
    await act(async () => host.querySelector("button")?.click());
    expect(host.textContent).toContain(locale.cloudErrorExpired);
  });
});
