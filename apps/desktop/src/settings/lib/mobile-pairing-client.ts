import { desktopFetch } from "@/lib/backend-client";

/**
 * Desktop side of phone pairing: the `/rpc/mobile/*` contract from
 * docs/20261114_mobile-app-architecture.md §5. Timestamps are epoch
 * milliseconds.
 */

/** Loopback is never offered: on the phone it names the phone. */
export type NetworkAddressKind = "lan" | "tailnet";

export interface NetworkAddress {
  address: string;
  kind: NetworkAddressKind;
  /** Interface name or a short human label (e.g. `en0`, `Tailscale`). */
  label: string;
}

export interface NetworkInterfacesResponse {
  addresses: NetworkAddress[];
}

/**
 * Addresses the user typed, saved in the desktop config. The server checks
 * each one is dialable before saving and answers with what it stored
 * (trimmed, without duplicates).
 */
export interface AddressPreference {
  customAddresses: string[];
  /** The custom address pairing codes advertise; null uses a detected one. */
  selectedCustomAddress: string | null;
}

export interface PairingOfferRequest {
  /** Address to advertise in the offer; the server picks one when absent. */
  address?: string;
  /** Drop every unscanned offer and mint a fresh one. */
  rotate?: boolean;
}

export interface PairingOffer {
  /** `chro://pair?code=...`, what the phone scans or pastes. */
  pairingUrl: string;
  /** QR image of `pairingUrl`, rendered by the server. Empty when it could not be drawn. */
  qrSvg: string;
  /** WebSocket endpoint the phone will dial, e.g. `ws://192.168.1.23:6768`. */
  endpoint: string;
  /** The offer stops authenticating at this instant (10 minutes after issue). */
  expiresAt: number;
}

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt?: number;
}

export interface PairedDevicesResponse {
  devices: PairedDevice[];
}

export interface MobilePairingApi {
  listInterfaces: () => Promise<NetworkInterfacesResponse>;
  getAddressPreference: () => Promise<AddressPreference>;
  saveAddressPreference: (
    preference: AddressPreference,
  ) => Promise<AddressPreference>;
  createPairingOffer: (request: PairingOfferRequest) => Promise<PairingOffer>;
  listDevices: () => Promise<PairedDevicesResponse>;
  revokeDevice: (id: string) => Promise<void>;
}

/**
 * The server answers failures as `{error: {code, message}}`; show the
 * message, not the JSON. Other bodies pass through as they are.
 */
function serverMessage(raw: string): string {
  try {
    const message = JSON.parse(raw)?.error?.message;
    return typeof message === "string" ? message : raw;
  } catch {
    return raw;
  }
}

async function mobileFetch<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await desktopFetch<T>(path, init);
  } catch (error) {
    if (error instanceof Error) throw new Error(serverMessage(error.message));
    throw error;
  }
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const mobilePairingApi: MobilePairingApi = {
  listInterfaces: () =>
    mobileFetch<NetworkInterfacesResponse>("/rpc/mobile/interfaces"),
  getAddressPreference: () =>
    mobileFetch<AddressPreference>("/rpc/mobile/address-preference"),
  saveAddressPreference: (preference) =>
    mobileFetch<AddressPreference>(
      "/rpc/mobile/address-preference",
      jsonBody("PUT", preference),
    ),
  createPairingOffer: (request) =>
    mobileFetch<PairingOffer>(
      "/rpc/mobile/pairing-offer",
      jsonBody("POST", request),
    ),
  listDevices: () => mobileFetch<PairedDevicesResponse>("/rpc/mobile/devices"),
  revokeDevice: async (id) => {
    await mobileFetch<unknown>(
      `/rpc/mobile/devices/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
};

const ADDRESS_PREFERENCE: NetworkAddressKind[] = ["tailnet", "lan"];

/**
 * The detected address to advertise before the user picks one. A tailnet
 * address reaches the phone both at home and away, so it wins over the LAN.
 */
export function pickDefaultAddress(addresses: NetworkAddress[]): string | null {
  for (const kind of ADDRESS_PREFERENCE) {
    const match = addresses.find((entry) => entry.kind === kind);
    if (match) return match.address;
  }
  return null;
}

/** The TCP port the phone dials, for the firewall hint. */
export function endpointPort(endpoint: string): string | null {
  try {
    const port = new URL(endpoint).port;
    return port === "" ? null : port;
  } catch {
    return null;
  }
}
