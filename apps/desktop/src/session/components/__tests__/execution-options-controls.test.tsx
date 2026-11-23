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
  it("shows the branch chip and hides cloud when the flag is off", async () => {
    const host = await render(false);
    expect(
      host.querySelector(`[aria-label="${locale.cloudLocationComputer}"]`),
    ).toBeNull();
    expect(
      host.querySelector(`[aria-label="${locale.environmentFromLabel}"]`)
        ?.textContent,
    ).toBe("main");
    expect(
      host.querySelector(`[aria-label="${locale.environmentWorktreeLabel}"]`)
        ?.textContent,
    ).toBe(locale.environmentWorktreeLabel);
    expect(host.querySelector(".lucide-ellipsis")).toBeNull();
    expect(desktopFetch).not.toHaveBeenCalled();
  });
  it("switches the checkout mode from the checkout chip", async () => {
    const onUseWorktreeChange = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () =>
      root.render(
        <NewSessionExecutionControls
          {...props}
          onUseWorktreeChange={onUseWorktreeChange}
        />,
      ),
    );
    const trigger = host.querySelector(
      `[aria-label="${locale.environmentWorktreeLabel}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      ),
    );
    const items = [...document.querySelectorAll('[role="menuitemradio"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      locale.environmentWorktreeLabel,
      locale.environmentLocalLabel,
    ]);
    expect(items[0]?.getAttribute("aria-checked")).toBe("true");
    await act(async () =>
      items[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(onUseWorktreeChange).toHaveBeenCalledWith(false);
  });
  it("offers This computer and Cloud when the flag is on", async () => {
    const host = await render(true);
    expect(
      host.querySelector(`[aria-label="${locale.cloudLocationComputer}"]`)
        ?.textContent,
    ).toBe(locale.cloudLocationComputer);
    expect(host.querySelector(".lucide-laptop")).not.toBeNull();
    expect(host.querySelector(".lucide-ellipsis")).not.toBeNull();
    expect(host.textContent).not.toContain("main");
    await openMenu(host);
    expect(document.querySelector("input")?.placeholder).toBe(
      locale.cloudWorkIn,
    );
    expect(document.body.textContent).toContain(locale.cloudLocationComputer);
    expect(document.body.textContent).toContain(locale.cloudDefaultEnvironment);
    expect(desktopFetch).not.toHaveBeenCalled();
  });
  it("filters environment rows and shows the empty state", async () => {
    const host = await render(false);
    const trigger = host.querySelector(
      `[aria-label="${locale.environmentWorktreeLabel}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      ),
    );
    const input = document.querySelector("input")!;
    expect(input.placeholder).toBe(locale.executionEnvironmentSearch);
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(input, locale.environmentLocalLabel);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(1);
    await act(async () => {
      setValue.call(input, "no-match-123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain(locale.executionPickerEmpty);
  });
  it("filters location rows by label and secondary text", async () => {
    const host = await render(true);
    await openMenu(host);
    const input = document.querySelector("input")!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(input, locale.cloudDefaultEnvironment);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(1);
    expect(
      document.querySelector('[role="menuitemradio"]')?.textContent,
    ).toContain(locale.cloudLocationCloud);
    await act(async () => {
      setValue.call(input, "no-match-123");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain(locale.executionPickerEmpty);
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it("keeps branch and environment accessible under more options", async () => {
    const host = await render(true);
    const trigger = host.querySelector(
      `[aria-label="${locale.executionMoreOptions}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    expect(
      document.querySelector(`[aria-label="${locale.environmentFromLabel}"]`),
    ).not.toBeNull();
    expect(
      document.querySelector(
        `[aria-label="${locale.environmentWorktreeLabel}"]`,
      ),
    ).not.toBeNull();
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
  it("checks the existing Access sign-in before selecting Cloud", async () => {
    vi.mocked(desktopFetch).mockResolvedValueOnce({ signed_in: true });
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
    expect(desktopFetch).toHaveBeenCalledWith("/rpc/cloud/status");
    expect(desktopFetch).not.toHaveBeenCalledWith(
      "/rpc/cloud/login",
      expect.anything(),
    );
    expect(onChange).toHaveBeenCalledWith("cloud");
    expect(pending.mock.calls).toEqual([[true], [false]]);
  });
  it("keeps the computer selected and surfaces a sign-in failure", async () => {
    vi.mocked(desktopFetch).mockResolvedValueOnce({ signed_in: false });
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
      locale.cloudErrorSignInFirst,
    );
  });
});
