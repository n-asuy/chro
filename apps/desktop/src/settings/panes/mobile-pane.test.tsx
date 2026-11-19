/**
 * @vitest-environment jsdom
 */
import { LanguageProvider } from "@/i18n";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AddressPreference,
  MobilePairingApi,
  NetworkAddress,
  PairedDevice,
  PairingOffer,
} from "../lib/mobile-pairing-client";
import { MobilePane } from "./mobile-pane";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const TEN_MINUTES = 10 * 60 * 1000;

const LAN: NetworkAddress = {
  address: "192.168.1.23",
  kind: "lan",
  label: "en0",
};
const TAILNET: NetworkAddress = {
  address: "100.101.102.103",
  kind: "tailnet",
  label: "Tailscale",
};

const IPHONE: PairedDevice = {
  id: "device-1",
  name: "iPhone 16",
  pairedAt: NOW - 24 * 60 * 60 * 1000,
  lastSeenAt: NOW - 60_000,
};
const IPAD: PairedDevice = {
  id: "device-2",
  name: "iPad mini",
  pairedAt: NOW,
};

function offer(overrides: Partial<PairingOffer> = {}): PairingOffer {
  return {
    pairingUrl: "chro://pair?code=eyJ2IjoyfQ",
    qrSvg:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    endpoint: "ws://100.101.102.103:6768",
    expiresAt: Date.now() + TEN_MINUTES,
    ...overrides,
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type MockApi = {
  [K in keyof MobilePairingApi]: ReturnType<typeof vi.fn> & MobilePairingApi[K];
};

const NO_CUSTOM: AddressPreference = {
  customAddresses: [],
  selectedCustomAddress: null,
};

function mockApi(
  init: {
    addresses?: NetworkAddress[];
    devices?: PairedDevice[];
    preference?: AddressPreference;
  } = {},
): MockApi {
  return {
    listInterfaces: vi.fn(async () => ({
      addresses: init.addresses ?? [LAN, TAILNET],
    })),
    getAddressPreference: vi.fn(async () => init.preference ?? NO_CUSTOM),
    // The server echoes what it saved.
    saveAddressPreference: vi.fn(
      async (preference: AddressPreference) => preference,
    ),
    createPairingOffer: vi.fn(async () => offer()),
    listDevices: vi.fn(async () => ({ devices: init.devices ?? [] })),
    revokeDevice: vi.fn(async () => {}),
  } as MockApi;
}

let container: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState;
let focused: boolean;

beforeEach(() => {
  vi.useFakeTimers({
    now: NOW,
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  // The language provider asks the server for the saved language; leave it on
  // the English default.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unavailable", { status: 503 })),
  );
  visibility = "visible";
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

async function mount(api: MockApi, platform = "darwin") {
  act(() => {
    root.render(
      <LanguageProvider>
        <MobilePane api={api} platform={platform} />
      </LanguageProvider>,
    );
  });
  await flush();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

function text(): string {
  return document.body.textContent ?? "";
}

function button(name: string | RegExp): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find((el) => {
    const label = el.getAttribute("aria-label") ?? el.textContent ?? "";
    return typeof name === "string" ? label.trim() === name : name.test(label);
  });
  if (!match) throw new Error(`no button named ${String(name)}`);
  return match;
}

function queryButton(name: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (el) =>
      (el.getAttribute("aria-label") ?? el.textContent ?? "").trim() === name,
  );
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function openMenu(trigger: Element) {
  await act(async () => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await flush();
}

function menuItem(label: string): HTMLElement {
  const item = Array.from(
    document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((el) => el.textContent?.trim() === label);
  if (!item) throw new Error(`no menu item ${label}`);
  return item;
}

function addressInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    '[role="dialog"] input',
  );
  if (!input) throw new Error("the address dialog is not open");
  return input;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

async function openAddressMenu() {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-haspopup="menu"]',
  );
  if (!trigger) throw new Error("no address picker");
  await openMenu(trigger);
}

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();
}

function qrImage(): HTMLImageElement | null {
  return document.querySelector('img[alt="QR code for pairing your phone"]');
}

describe("MobilePane: addresses", () => {
  it("shows both sections loading until the server answers", async () => {
    const api = mockApi();
    api.listInterfaces.mockReturnValue(new Promise(() => {}));
    api.listDevices.mockReturnValue(new Promise(() => {}));
    await mount(api);

    expect(text()).toContain("Pair a phone");
    expect(text()).toContain("Looking for network addresses…");
    expect(text()).toContain("Loading paired devices…");
    expect(button("Generate QR code").disabled).toBe(true);
  });

  it("reports an address lookup failure and retries on refresh", async () => {
    const api = mockApi();
    api.listInterfaces.mockRejectedValueOnce(new Error("socket closed"));
    await mount(api);

    expect(text()).toContain("Couldn’t read network addresses.");
    expect(text()).toContain("socket closed");
    expect(button("Generate QR code").disabled).toBe(true);

    await click(button("Refresh network addresses"));
    expect(api.listInterfaces).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("Couldn’t read network addresses.");
    expect(button("Generate QR code").disabled).toBe(false);
  });

  it("explains what to do when there is no address to advertise", async () => {
    await mount(mockApi({ addresses: [] }));

    expect(text()).toContain(
      "No network address found. Connect to Wi‑Fi or Tailscale, then refresh.",
    );
    expect(button("Generate QR code").disabled).toBe(true);
  });

  it("preselects the tailnet address and lists every address with its label", async () => {
    await mount(mockApi());

    const trigger = button(/100\.101\.102\.103/);
    expect(trigger.textContent).toContain("100.101.102.103 (Tailscale)");

    await openMenu(trigger);
    expect(text()).toContain("192.168.1.23 (en0)");
  });
});

describe("MobilePane: custom address", () => {
  const MAGIC_DNS = "mac.tail1234.ts.net";

  it("lists saved custom addresses in their own section with a remove action", async () => {
    await mount(
      mockApi({
        preference: {
          customAddresses: [MAGIC_DNS, "relay.example.com:8443"],
          selectedCustomAddress: null,
        },
      }),
    );
    await openAddressMenu();

    expect(text()).toContain("Custom");
    expect(menuItem(`${MAGIC_DNS} (custom)`)).toBeDefined();
    expect(menuItem("relay.example.com:8443 (custom)")).toBeDefined();
    expect(button(`Remove ${MAGIC_DNS}`)).toBeDefined();
    expect(menuItem("Add custom address…")).toBeDefined();
    expect(text()).not.toContain("127.0.0.1");
  });

  it("restores the saved custom selection and pairs with it", async () => {
    const api = mockApi({
      preference: {
        customAddresses: [MAGIC_DNS],
        selectedCustomAddress: MAGIC_DNS,
      },
    });
    await mount(api);

    expect(button(new RegExp(MAGIC_DNS)).textContent).toContain(
      `${MAGIC_DNS} (custom)`,
    );
    await click(button("Generate QR code"));
    expect(api.createPairingOffer).toHaveBeenCalledWith({
      address: MAGIC_DNS,
      rotate: false,
    });
  });

  it("adds a custom address from the dialog, saves it and selects it", async () => {
    const api = mockApi();
    await mount(api);
    await click(button("Generate QR code"));
    expect(qrImage()).not.toBeNull();

    await openAddressMenu();
    await click(menuItem("Add custom address…"));

    expect(text()).toContain("Custom network address");
    expect(text()).toContain(
      "Advertise an address your phone can reach: for example, a Tailscale hostname, IP address, or reverse-proxy URL.",
    );
    expect(text()).toContain(
      "Enter an IPv4/IPv6 address, hostname, or full HTTP(S)/WebSocket URL. Ports are optional.",
    );
    const input = addressInput();
    expect(input.placeholder).toBe(
      "home.example.com:8443 or https://relay.example.com",
    );
    expect(button("Use address").disabled).toBe(true);

    await typeInto(input, `  ${MAGIC_DNS}:7443 `);
    await click(button("Use address"));

    expect(api.saveAddressPreference).toHaveBeenCalledWith({
      customAddresses: [`${MAGIC_DNS}:7443`],
      selectedCustomAddress: `${MAGIC_DNS}:7443`,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button(new RegExp(MAGIC_DNS)).textContent).toContain(
      `${MAGIC_DNS}:7443 (custom)`,
    );
    expect(qrImage()).toBeNull();

    await click(button("Generate QR code"));
    expect(api.createPairingOffer).toHaveBeenLastCalledWith({
      address: `${MAGIC_DNS}:7443`,
      rotate: true,
    });
  });

  it("keeps the dialog open with the server's reason when it refuses the address", async () => {
    const api = mockApi();
    api.saveAddressPreference.mockRejectedValueOnce(
      new Error('"two words": contains a space'),
    );
    await mount(api);
    await openAddressMenu();
    await click(menuItem("Add custom address…"));
    await typeInto(addressInput(), "two words");
    await click(button("Use address"));

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(text()).toContain('"two words": contains a space');
    expect(button(/100\.101\.102\.103/).textContent).toContain(
      "100.101.102.103 (Tailscale)",
    );
  });

  it("removing the selected custom address falls back to the detected one", async () => {
    const api = mockApi({
      preference: {
        customAddresses: [MAGIC_DNS],
        selectedCustomAddress: MAGIC_DNS,
      },
    });
    await mount(api);
    await openAddressMenu();
    await click(button(`Remove ${MAGIC_DNS}`));

    expect(api.saveAddressPreference).toHaveBeenCalledWith({
      customAddresses: [],
      selectedCustomAddress: null,
    });
    expect(button(/100\.101\.102\.103/).textContent).toContain(
      "100.101.102.103 (Tailscale)",
    );
  });

  it("picking a detected address clears the saved custom selection", async () => {
    const api = mockApi({
      preference: {
        customAddresses: [MAGIC_DNS],
        selectedCustomAddress: MAGIC_DNS,
      },
    });
    await mount(api);
    await openAddressMenu();
    await click(menuItem("192.168.1.23 (en0)"));

    expect(api.saveAddressPreference).toHaveBeenCalledWith({
      customAddresses: [MAGIC_DNS],
      selectedCustomAddress: null,
    });
    expect(button(/192\.168\.1\.23/).textContent).toContain(
      "192.168.1.23 (en0)",
    );
  });

  it("offers a custom address even when no interface is detected", async () => {
    await mount(mockApi({ addresses: [] }));
    await openAddressMenu();
    expect(menuItem("Add custom address…")).toBeDefined();
  });
});

describe("MobilePane: pairing offer", () => {
  it("generates an offer for the selected address and shows the QR", async () => {
    const api = mockApi();
    await mount(api);

    await click(button("Generate QR code"));

    expect(api.createPairingOffer).toHaveBeenCalledWith({
      address: TAILNET.address,
      rotate: false,
    });
    const img = qrImage();
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(img?.getAttribute("src") ?? "")).toContain(
      "<rect",
    );
    expect(text()).toContain("ws://100.101.102.103:6768");
    expect(text()).toContain("chro://pair?code=eyJ2IjoyfQ");
    expect(text()).toContain(
      "The code refreshes automatically. A copied link works for up to 10 minutes.",
    );
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Pairing code ready",
    );
    expect(queryButton("Regenerate QR code")).toBeDefined();
  });

  it("shows a spinner and disables the button while the offer is being minted", async () => {
    const api = mockApi();
    const pending = deferred<PairingOffer>();
    api.createPairingOffer.mockReturnValueOnce(pending.promise);
    await mount(api);

    await click(button("Generate QR code"));
    const generate = button("Generate QR code");
    expect(generate.disabled).toBe(true);
    expect(generate.querySelector(".animate-spin")).not.toBeNull();

    pending.resolve(offer());
    await flush();
    expect(qrImage()).not.toBeNull();
  });

  it("rotates the offer when the user regenerates", async () => {
    const api = mockApi();
    await mount(api);
    await click(button("Generate QR code"));
    await click(button("Regenerate QR code"));

    expect(api.createPairingOffer).toHaveBeenLastCalledWith({
      address: TAILNET.address,
      rotate: true,
    });
  });

  it("drops the offer when the address changes and rotates on the next one", async () => {
    const api = mockApi();
    await mount(api);
    await click(button("Generate QR code"));
    expect(qrImage()).not.toBeNull();

    await openMenu(button(/100\.101\.102\.103/));
    const item = Array.from(
      document.querySelectorAll('[role="menuitem"]'),
    ).find((el) => el.textContent?.includes("192.168.1.23"));
    if (!item) throw new Error("LAN address missing from the menu");
    await click(item);

    expect(qrImage()).toBeNull();
    await click(button("Generate QR code"));
    expect(api.createPairingOffer).toHaveBeenLastCalledWith({
      address: LAN.address,
      rotate: true,
    });
  });

  it("reports a failed offer with the server's reason", async () => {
    const api = mockApi();
    api.createPairingOffer.mockRejectedValueOnce(
      new Error("pairing registry unavailable"),
    );
    await mount(api);
    await click(button("Generate QR code"));

    expect(text()).toContain("Couldn’t create a pairing code.");
    expect(text()).toContain("pairing registry unavailable");
    expect(qrImage()).toBeNull();
    expect(button("Generate QR code").disabled).toBe(false);
  });

  it("falls back to the link when the server could not draw the QR", async () => {
    const api = mockApi();
    api.createPairingOffer.mockResolvedValueOnce(offer({ qrSvg: "" }));
    await mount(api);
    await click(button("Generate QR code"));

    expect(qrImage()).toBeNull();
    expect(text()).toContain(
      "This pairing code couldn’t be drawn as a QR code. Copy the link into the chro app instead.",
    );
    expect(queryButton("Copy pairing link")).toBeDefined();
  });

  it("copies the whole pairing link and confirms for two seconds", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mount(mockApi());
    await click(button("Generate QR code"));

    await click(button("Copy pairing link"));
    expect(writeText).toHaveBeenCalledWith("chro://pair?code=eyJ2IjoyfQ");
    expect(queryButton("Pairing link copied")).toBeDefined();

    await advance(2000);
    expect(queryButton("Pairing link copied")).toBeUndefined();
    expect(queryButton("Copy pairing link")).toBeDefined();
  });

  it("says so when the clipboard refuses the link", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mount(mockApi());
    await click(button("Generate QR code"));

    await click(button("Copy pairing link"));
    expect(text()).toContain("Couldn’t copy the pairing link.");
  });

  it("refreshes the code a minute before it expires while the window is visible", async () => {
    const api = mockApi();
    api.createPairingOffer
      .mockResolvedValueOnce(
        offer({
          pairingUrl: "chro://pair?code=first",
          expiresAt: NOW + TEN_MINUTES,
        }),
      )
      .mockImplementationOnce(async () =>
        offer({ pairingUrl: "chro://pair?code=second" }),
      );
    await mount(api);
    await click(button("Generate QR code"));

    await advance(8 * 60 * 1000);
    expect(api.createPairingOffer).toHaveBeenCalledTimes(1);

    await advance(60 * 1000 + 15_000);
    expect(api.createPairingOffer).toHaveBeenCalledTimes(2);
    expect(api.createPairingOffer).toHaveBeenLastCalledWith({
      address: TAILNET.address,
      rotate: false,
    });
    expect(text()).toContain("chro://pair?code=second");
  });

  it("marks the code expired while hidden and replaces it once visible again", async () => {
    const api = mockApi();
    api.createPairingOffer
      .mockResolvedValueOnce(offer({ expiresAt: NOW + TEN_MINUTES }))
      .mockImplementationOnce(async () =>
        offer({ pairingUrl: "chro://pair?code=fresh" }),
      );
    await mount(api);
    await click(button("Generate QR code"));

    await setVisibility("hidden");
    await advance(TEN_MINUTES + 15_000);
    expect(api.createPairingOffer).toHaveBeenCalledTimes(1);
    expect(text()).toContain("This code has expired. Generate a new one.");
    expect(qrImage()).toBeNull();
    expect(queryButton("Copy pairing link")).toBeUndefined();

    await setVisibility("visible");
    expect(api.createPairingOffer).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain("This code has expired.");
    expect(text()).toContain("chro://pair?code=fresh");
  });

  it("does not re-mint in a loop when the server issues a code that is already about to lapse", async () => {
    const api = mockApi();
    api.createPairingOffer.mockImplementation(async () =>
      offer({ expiresAt: Date.now() + 20_000 }),
    );
    await mount(api);
    await click(button("Generate QR code"));

    expect(api.createPairingOffer).toHaveBeenCalledTimes(1);
    expect(qrImage()).not.toBeNull();

    await advance(19_000);
    expect(text()).not.toContain("This code has expired.");

    // Expiry shows the moment it happens, not at the next clock tick.
    await advance(1_000);
    expect(api.createPairingOffer).toHaveBeenCalledTimes(1);
    expect(text()).toContain("This code has expired. Generate a new one.");
  });

  it("stays expired without retrying in a loop when the refresh fails", async () => {
    const api = mockApi();
    api.createPairingOffer
      .mockResolvedValueOnce(offer({ expiresAt: NOW + TEN_MINUTES }))
      .mockRejectedValue(new Error("listener stopped"));
    await mount(api);
    await click(button("Generate QR code"));

    await advance(TEN_MINUTES + 60_000);
    expect(api.createPairingOffer).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Couldn’t create a pairing code.");
    expect(text()).toContain("This code has expired. Generate a new one.");

    await click(button("Regenerate QR code"));
    expect(api.createPairingOffer).toHaveBeenCalledTimes(3);
  });
});

describe("MobilePane: paired devices", () => {
  it("says no phone is paired yet", async () => {
    await mount(mockApi({ devices: [] }));
    expect(text()).toContain("No phones paired yet.");
    expect(text()).not.toContain("Scan the QR code");
  });

  it("points at the QR code when one is on screen and nothing is paired", async () => {
    await mount(mockApi({ devices: [] }));
    await click(button("Generate QR code"));
    expect(text()).toContain(
      "No phones paired yet. Scan the QR code with the chro app.",
    );
  });

  it("lists paired devices with their pairing date", async () => {
    await mount(mockApi({ devices: [IPHONE, IPAD] }));
    expect(text()).toContain("iPhone 16");
    expect(text()).toContain("Paired Nov 13, 2026");
    expect(text()).toContain("iPad mini");
    expect(text()).toContain("Paired Nov 14, 2026");
    expect(text()).toContain("Revoking a device disconnects it immediately.");
  });

  it("reports a failed device listing and retries", async () => {
    const api = mockApi({ devices: [IPHONE] });
    api.listDevices.mockRejectedValueOnce(new Error("registry unreadable"));
    await mount(api);

    expect(text()).toContain("Couldn’t load paired devices.");
    expect(text()).toContain("registry unreadable");

    await click(button("Retry"));
    expect(text()).toContain("iPhone 16");
  });

  it("polls for the new phone while the code is on screen and stops once it appears", async () => {
    const api = mockApi({ devices: [] });
    await mount(api);
    await click(button("Generate QR code"));
    const baseline = api.listDevices.mock.calls.length;

    focused = false;
    await advance(3000);
    expect(api.listDevices).toHaveBeenCalledTimes(baseline);

    focused = true;
    await advance(3000);
    expect(api.listDevices).toHaveBeenCalledTimes(baseline + 1);

    api.listDevices.mockResolvedValue({ devices: [IPHONE] });
    await advance(3000);
    expect(text()).toContain("iPhone 16");
    const afterPair = api.listDevices.mock.calls.length;

    await advance(9000);
    expect(api.listDevices).toHaveBeenCalledTimes(afterPair);
  });
});

describe("MobilePane: revoke", () => {
  function revokeButtonFor(name: string): HTMLButtonElement {
    return button(`Revoke ${name}`);
  }

  it("asks before revoking and does nothing on cancel", async () => {
    const api = mockApi({ devices: [IPHONE] });
    await mount(api);

    await click(revokeButtonFor("iPhone 16"));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Revoke iPhone 16?");
    expect(dialog?.textContent).toContain(
      "The phone is disconnected immediately and has to be paired again to reconnect.",
    );

    await click(button("Cancel"));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(api.revokeDevice).not.toHaveBeenCalled();
    expect(text()).toContain("iPhone 16");
  });

  it("revokes on confirm and reloads the list", async () => {
    const api = mockApi({ devices: [IPHONE, IPAD] });
    await mount(api);

    await click(revokeButtonFor("iPhone 16"));
    api.listDevices.mockResolvedValue({ devices: [IPAD] });
    const dialog = document.querySelector('[role="alertdialog"]');
    const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (el) => el.textContent?.trim() === "Revoke",
    );
    if (!confirm) throw new Error("no confirm button");
    await click(confirm);

    expect(api.revokeDevice).toHaveBeenCalledWith("device-1");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(text()).not.toContain("iPhone 16");
    expect(text()).toContain("iPad mini");
  });

  it("keeps the device and reports the failure when revoking fails", async () => {
    const api = mockApi({ devices: [IPHONE] });
    api.revokeDevice.mockRejectedValueOnce(new Error("disk full"));
    await mount(api);

    await click(revokeButtonFor("iPhone 16"));
    const dialog = document.querySelector('[role="alertdialog"]');
    const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (el) => el.textContent?.trim() === "Revoke",
    );
    if (!confirm) throw new Error("no confirm button");
    await click(confirm);

    expect(text()).toContain("Couldn’t revoke iPhone 16.");
    expect(text()).toContain("disk full");
    expect(text()).toContain("iPhone 16");
  });
});

describe("MobilePane: Windows firewall", () => {
  it("tells Windows users to allow the pairing port on private networks", async () => {
    await mount(mockApi(), "win32");
    expect(text()).toContain("Windows Firewall may block your phone");
    expect(text()).toContain(
      "Allow chro through Windows Firewall on Private networks, and set this Wi‑Fi network to Private.",
    );

    await click(button("Generate QR code"));
    expect(text()).toContain(
      "Allow chro through Windows Firewall for TCP port 6768 on Private networks, and set this Wi‑Fi network to Private.",
    );
  });

  it("stays quiet on other platforms", async () => {
    await mount(mockApi(), "darwin");
    await click(button("Generate QR code"));
    expect(text()).not.toContain("Windows Firewall");
  });
});
