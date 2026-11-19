import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type NetworkAddress,
  endpointPort,
  mobilePairingApi,
  pickDefaultAddress,
} from "./mobile-pairing-client";

/**
 * The client must speak the `/rpc/mobile/*` contract exactly as written in
 * docs/20261114_mobile-app-architecture.md §5; the server is built against the
 * same table, so any drift here is a wire break.
 */
type FetchCall = { url: string; init: RequestInit | undefined };

let calls: FetchCall[];
let nextResponse: Response;

beforeEach(() => {
  calls = [];
  nextResponse = new Response("{}", { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return nextResponse;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("mobilePairingApi", () => {
  it("lists addresses with GET /rpc/mobile/interfaces", async () => {
    nextResponse = json({
      addresses: [{ address: "192.168.1.23", kind: "lan", label: "en0" }],
    });
    const result = await mobilePairingApi.listInterfaces();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/rpc\/mobile\/interfaces$/);
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(result.addresses[0].address).toBe("192.168.1.23");
  });

  it("creates an offer with POST /rpc/mobile/pairing-offer and a JSON body", async () => {
    nextResponse = json({
      pairingUrl: "chro://pair?code=abc",
      qrSvg: "<svg/>",
      endpoint: "ws://192.168.1.23:6768",
      expiresAt: 1_700_000_600_000,
    });
    const offer = await mobilePairingApi.createPairingOffer({
      address: "192.168.1.23",
      rotate: true,
    });
    expect(calls[0].url).toMatch(/\/rpc\/mobile\/pairing-offer$/);
    expect(calls[0].init?.method).toBe("POST");
    expect(new Headers(calls[0].init?.headers).get("content-type")).toContain(
      "application/json",
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      address: "192.168.1.23",
      rotate: true,
    });
    expect(offer.pairingUrl).toBe("chro://pair?code=abc");
  });

  it("omits fields the caller left out of the offer request", async () => {
    nextResponse = json({
      pairingUrl: "chro://pair?code=abc",
      qrSvg: "<svg/>",
      endpoint: "ws://192.168.1.23:6768",
      expiresAt: 1,
    });
    await mobilePairingApi.createPairingOffer({});
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({});
  });

  it("lists devices with GET /rpc/mobile/devices", async () => {
    nextResponse = json({
      devices: [{ id: "d1", name: "iPhone", pairedAt: 1 }],
    });
    const result = await mobilePairingApi.listDevices();
    expect(calls[0].url).toMatch(/\/rpc\/mobile\/devices$/);
    expect(result.devices).toEqual([{ id: "d1", name: "iPhone", pairedAt: 1 }]);
  });

  it("revokes with DELETE /rpc/mobile/devices/:id and escapes the id", async () => {
    await mobilePairingApi.revokeDevice("a/b c");
    expect(calls[0].url).toMatch(/\/rpc\/mobile\/devices\/a%2Fb%20c$/);
    expect(calls[0].init?.method).toBe("DELETE");
  });

  it("surfaces the server's plain-text error body", async () => {
    nextResponse = new Response("registry unavailable", { status: 503 });
    await expect(mobilePairingApi.listDevices()).rejects.toThrow(
      "registry unavailable",
    );
  });

  it("surfaces the message of a JSON error, not the JSON", async () => {
    nextResponse = new Response(
      JSON.stringify({
        error: { code: "invalid_address", message: '"a b": contains a space' },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    await expect(
      mobilePairingApi.createPairingOffer({ address: "a b" }),
    ).rejects.toThrow(/^"a b": contains a space$/);
  });

  it("reads the saved custom addresses with GET /rpc/mobile/address-preference", async () => {
    nextResponse = json({
      customAddresses: ["mac.tail1234.ts.net"],
      selectedCustomAddress: null,
    });
    const preference = await mobilePairingApi.getAddressPreference();
    expect(calls[0].url).toMatch(/\/rpc\/mobile\/address-preference$/);
    expect(calls[0].init?.method ?? "GET").toBe("GET");
    expect(preference).toEqual({
      customAddresses: ["mac.tail1234.ts.net"],
      selectedCustomAddress: null,
    });
  });

  it("saves the custom addresses with PUT /rpc/mobile/address-preference", async () => {
    const saved = {
      customAddresses: ["mac.tail1234.ts.net"],
      selectedCustomAddress: "mac.tail1234.ts.net",
    };
    nextResponse = json(saved);
    const result = await mobilePairingApi.saveAddressPreference(saved);
    expect(calls[0].url).toMatch(/\/rpc\/mobile\/address-preference$/);
    expect(calls[0].init?.method).toBe("PUT");
    expect(new Headers(calls[0].init?.headers).get("content-type")).toContain(
      "application/json",
    );
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(saved);
    expect(result).toEqual(saved);
  });
});

describe("pickDefaultAddress", () => {
  const lan: NetworkAddress = {
    address: "192.168.1.23",
    kind: "lan",
    label: "en0",
  };
  const tailnet: NetworkAddress = {
    address: "100.101.102.103",
    kind: "tailnet",
    label: "utun4",
  };

  it("prefers a tailnet address, which works on and off the home network", () => {
    expect(pickDefaultAddress([lan, tailnet])).toBe(tailnet.address);
  });

  it("falls back to the first LAN address", () => {
    expect(pickDefaultAddress([lan])).toBe(lan.address);
  });

  it("returns null when there is nothing to advertise", () => {
    expect(pickDefaultAddress([])).toBeNull();
  });
});

describe("endpointPort", () => {
  it("reads the explicit port of the advertised endpoint", () => {
    expect(endpointPort("ws://192.168.1.23:6768")).toBe("6768");
    expect(endpointPort("ws://[fd7a:115c::1]:6769")).toBe("6769");
  });

  it("returns null when the endpoint carries no port or is not a URL", () => {
    expect(endpointPort("ws://phone.example")).toBeNull();
    expect(endpointPort("not a url")).toBeNull();
  });
});
