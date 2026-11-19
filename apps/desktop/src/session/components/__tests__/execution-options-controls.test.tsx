// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewSessionExecutionControls } from "../execution-options-controls";

import en from "@/i18n/locales/en";
import ja from "@/i18n/locales/ja";
let locale = en;
vi.mock("@/i18n", () => ({
  useLanguage: () => ({ t: (key: keyof typeof en) => locale[key] }),
}));
vi.mock("@/lib/backend-client", () => ({ desktopFetch: vi.fn() }));
import { desktopFetch } from "@/lib/backend-client";

const props = {
  useWorktree: true,
  onUseWorktreeChange: vi.fn(),
  baseBranch: "main",
  baseBranchSearch: "",
  onBaseBranchSearchChange: vi.fn(),
  filteredBaseBranches: [{ name: "main", is_current: true }],
  onBaseBranchSelect: vi.fn(),
};
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const roots: ReturnType<typeof createRoot>[] = [];
async function render(
  cloudEnabled: boolean,
  onChange = vi.fn(),
  onPending = vi.fn(),
  executionLocation: "computer" | "cloud" = "computer",
) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <NewSessionExecutionControls
        {...props}
        cloudEnabled={cloudEnabled}
        executionLocation={executionLocation}
        onExecutionLocationChange={onChange}
        onCloudSignInPendingChange={onPending}
      />,
    ),
  );
  return host;
}
async function openMenu(host: HTMLElement) {
  const trigger = host.querySelector(
    `[aria-label="${locale.cloudLocationComputer}"]`,
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
    ),
  );
}
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.resetAllMocks();
});
describe.each([
  ["en", en],
  ["ja", ja],
] as const)("new session execution location (%s)", (_language, dictionary) => {
  beforeEach(() => {
    locale = dictionary;
  });
  it("hides cloud and keeps branch controls inside the options menu when the flag is off", async () => {
    const host = await render(false);
    expect(
      host.querySelector(`[aria-label="${locale.cloudLocationComputer}"]`),
    ).toBeNull();
    expect(
      host.querySelector(`[aria-label="${locale.cloudSessionOptions}"]`),
    ).not.toBeNull();
    expect(host.textContent).not.toContain("main");
    expect(desktopFetch).not.toHaveBeenCalled();
  });
  it("offers This computer and Cloud when the flag is on", async () => {
    const host = await render(true);
    expect(
      host.querySelector(`[aria-label="${locale.cloudLocationComputer}"]`)
        ?.textContent,
    ).toBe(locale.cloudLocationComputer);
    expect(host.querySelector(".lucide-laptop")).not.toBeNull();
    await openMenu(host);
    expect(document.body.textContent).toContain(locale.cloudWorkIn);
    expect(document.body.textContent).toContain(locale.cloudLocationComputer);
    expect(document.body.textContent).toContain(locale.cloudDefaultEnvironment);
    expect(desktopFetch).not.toHaveBeenCalled();
  });
  it("shows the selected Cloud location on the trigger", async () => {
    const host = await render(true, vi.fn(), vi.fn(), "cloud");
    expect(
      host.querySelector(`[aria-label="${locale.cloudLocationCloud}"]`)
        ?.textContent,
    ).toBe(locale.cloudLocationCloud);
    expect(host.querySelector(".lucide-cloud")).not.toBeNull();
    expect(host.textContent).not.toContain(locale.cloudWorkIn);
  });
  it("signs in before selecting Cloud", async () => {
    vi.mocked(desktopFetch)
      .mockResolvedValueOnce({ signed_in: false })
      .mockResolvedValueOnce({ signed_in: true });
    const onChange = vi.fn();
    const pending = vi.fn();
    const host = await render(true, onChange, pending);
    await openMenu(host);
    const cloud = [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes(locale.cloudLocationCloud),
    )!;
    await act(async () =>
      cloud.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(desktopFetch).toHaveBeenCalledWith("/rpc/cloud/login", {
      method: "POST",
    });
    expect(onChange).toHaveBeenCalledWith("cloud");
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });
  it("keeps the computer selected and surfaces a sign-in failure", async () => {
    vi.mocked(desktopFetch).mockRejectedValueOnce(
      new Error("Cloud sign-in expired. Sign in again."),
    );
    const onChange = vi.fn();
    const host = await render(true, onChange);
    await openMenu(host);
    const cloud = [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes(locale.cloudLocationCloud),
    )!;
    await act(async () =>
      cloud.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      locale.cloudErrorExpired,
    );
  });
});
