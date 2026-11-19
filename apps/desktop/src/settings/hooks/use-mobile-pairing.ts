import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AddressPreference,
  type MobilePairingApi,
  type NetworkAddress,
  type PairedDevice,
  type PairingOffer,
  pickDefaultAddress,
} from "../lib/mobile-pairing-client";

/** Re-issue the code this long before it stops authenticating. */
export const OFFER_REFRESH_LEAD_MS = 60_000;
/** Wall-clock check cadence; timers drift or stall across sleep, the clock does not. */
export const OFFER_CLOCK_TICK_MS = 15_000;
/** How often to look for the phone that is scanning the code. */
export const DEVICE_POLL_MS = 3_000;

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: T };

export type OfferState = {
  /** The code on screen, kept while a replacement is minted or after a refresh failed. */
  current: PairingOffer | null;
  generating: boolean;
  error: string | null;
};

export type RevokeState = {
  /** Device awaiting confirmation in the dialog. */
  pending: PairedDevice | null;
  revoking: boolean;
  error: { name: string; message: string } | null;
};

const NO_CUSTOM_ADDRESS: AddressPreference = {
  customAddresses: [],
  selectedCustomAddress: null,
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isWindowVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

const isWindowActive = () =>
  isWindowVisible() && (typeof document === "undefined" || document.hasFocus());

/**
 * Everything the Mobile settings pane shows: the address to advertise
 * (detected, or a custom one saved on the server), the pairing code with its
 * expiry and automatic renewal, and the paired devices with revocation.
 */
export function useMobilePairing(api: MobilePairingApi) {
  const [interfaces, setInterfaces] = useState<Loadable<NetworkAddress[]>>({
    status: "loading",
  });
  const [preference, setPreference] =
    useState<AddressPreference>(NO_CUSTOM_ADDRESS);
  const [detectedAddress, setDetectedAddress] = useState<string | null>(null);
  const [addressSave, setAddressSave] = useState<{
    saving: boolean;
    error: string | null;
  }>({ saving: false, error: null });
  // A selected custom address wins over the detected one.
  const selectedAddress = preference.selectedCustomAddress ?? detectedAddress;
  const selectedIsCustom = preference.selectedCustomAddress !== null;
  const [offer, setOffer] = useState<OfferState>({
    current: null,
    generating: false,
    error: null,
  });
  const [devices, setDevices] = useState<Loadable<PairedDevice[]>>({
    status: "loading",
  });
  const [revoke, setRevoke] = useState<RevokeState>({
    pending: null,
    revoking: false,
    error: null,
  });
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(isWindowVisible);
  // Paired-device count when the code on screen was issued; null when unknown.
  const [scanBaseline, setScanBaseline] = useState<number | null>(null);
  const deviceCount = devices.status === "ready" ? devices.value.length : null;
  const deviceCountRef = useRef(deviceCount);
  deviceCountRef.current = deviceCount;

  // The next manual mint replaces every unscanned code (address changed, or the
  // user asked for a new one while a code was on screen).
  const rotateNextRef = useRef(false);
  // Responses from a superseded request (address changed mid-flight) are dropped.
  const offerRequestRef = useRef(0);
  // The code that must not be renewed automatically: its renewal already failed,
  // or it arrived with less than the lead time left (renewing it would only
  // yield another code inside the window, minting in a loop). The user decides.
  const noAutoRenewRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadInterfaces = useCallback(async () => {
    setInterfaces({ status: "loading" });
    try {
      const [{ addresses }, saved] = await Promise.all([
        api.listInterfaces(),
        api.getAddressPreference(),
      ]);
      if (!mountedRef.current) return;
      setInterfaces({ status: "ready", value: addresses });
      setPreference(saved);
      setDetectedAddress((previous) =>
        previous && addresses.some((entry) => entry.address === previous)
          ? previous
          : pickDefaultAddress(addresses),
      );
    } catch (error) {
      if (!mountedRef.current) return;
      setInterfaces({ status: "error", message: errorMessage(error) });
    }
  }, [api]);

  const loadDevices = useCallback(
    async ({ quiet }: { quiet: boolean } = { quiet: false }) => {
      if (!quiet) setDevices({ status: "loading" });
      try {
        const { devices: list } = await api.listDevices();
        if (!mountedRef.current) return list;
        setDevices({ status: "ready", value: list });
        return list;
      } catch (error) {
        if (!mountedRef.current) return null;
        // A failed background poll keeps the list the user is looking at.
        if (!quiet)
          setDevices({ status: "error", message: errorMessage(error) });
        return null;
      }
    },
    [api],
  );

  useEffect(() => {
    void loadInterfaces();
    void loadDevices();
  }, [loadInterfaces, loadDevices]);

  /**
   * `renewing` names the code being replaced automatically, so a failure is
   * remembered for that code instead of retried on every clock tick.
   */
  const mint = useCallback(
    async (rotate: boolean, renewing: string | null = null) => {
      if (!selectedAddress) return;
      const request = offerRequestRef.current + 1;
      offerRequestRef.current = request;
      setOffer((previous) => ({ ...previous, generating: true, error: null }));
      try {
        const next = await api.createPairingOffer({
          address: selectedAddress,
          rotate,
        });
        if (!mountedRef.current || offerRequestRef.current !== request) return;
        rotateNextRef.current = false;
        const issuedAt = Date.now();
        noAutoRenewRef.current =
          next.expiresAt - issuedAt <= OFFER_REFRESH_LEAD_MS
            ? next.pairingUrl
            : null;
        setNow(issuedAt);
        setScanBaseline(deviceCountRef.current);
        setOffer({ current: next, generating: false, error: null });
      } catch (error) {
        if (!mountedRef.current || offerRequestRef.current !== request) return;
        if (renewing) noAutoRenewRef.current = renewing;
        setOffer((previous) => ({
          ...previous,
          generating: false,
          error: errorMessage(error),
        }));
      }
    },
    [api, selectedAddress],
  );

  const generate = useCallback(() => {
    const rotate = rotateNextRef.current || offer.current !== null;
    void mint(rotate);
  }, [mint, offer.current]);

  // The code on screen names the old address: drop it, ignore any mint in
  // flight, and replace every unscanned code on the next mint.
  const dropOffer = useCallback(() => {
    offerRequestRef.current += 1;
    rotateNextRef.current = true;
    noAutoRenewRef.current = null;
    setScanBaseline(null);
    setOffer({ current: null, generating: false, error: null });
  }, []);

  /**
   * Save `next` on the server, then advertise what it stored. Throws the
   * server's reason when it refuses; the selection is unchanged then.
   */
  const savePreference = useCallback(
    async (next: AddressPreference, detected: string | null) => {
      setAddressSave({ saving: true, error: null });
      try {
        const saved = await api.saveAddressPreference(next);
        if (!mountedRef.current) return;
        setAddressSave({ saving: false, error: null });
        if ((saved.selectedCustomAddress ?? detected) !== selectedAddress) {
          dropOffer();
        }
        setPreference(saved);
        setDetectedAddress(detected);
      } catch (error) {
        if (mountedRef.current) setAddressSave({ saving: false, error: null });
        throw error;
      }
    },
    [api, selectedAddress, dropOffer],
  );

  // Picker actions report a refusal beside the picker.
  const savePreferenceFromPicker = useCallback(
    (next: AddressPreference, detected: string | null) => {
      savePreference(next, detected).catch((error) => {
        if (mountedRef.current) {
          setAddressSave({ saving: false, error: errorMessage(error) });
        }
      });
    },
    [savePreference],
  );

  const selectAddress = useCallback(
    (address: string) => {
      if (selectedIsCustom) {
        savePreferenceFromPicker(
          { ...preference, selectedCustomAddress: null },
          address,
        );
        return;
      }
      if (address === selectedAddress) return;
      dropOffer();
      setDetectedAddress(address);
    },
    [
      selectedIsCustom,
      selectedAddress,
      preference,
      savePreferenceFromPicker,
      dropOffer,
    ],
  );

  const selectCustomAddress = useCallback(
    (address: string) => {
      if (preference.selectedCustomAddress === address) return;
      savePreferenceFromPicker(
        { ...preference, selectedCustomAddress: address },
        detectedAddress,
      );
    },
    [preference, detectedAddress, savePreferenceFromPicker],
  );

  /** Save and select a typed address; rejects with the server's reason. */
  const addCustomAddress = useCallback(
    (raw: string) => {
      const address = raw.trim();
      const customAddresses = preference.customAddresses.includes(address)
        ? preference.customAddresses
        : [...preference.customAddresses, address];
      return savePreference(
        { customAddresses, selectedCustomAddress: address },
        detectedAddress,
      );
    },
    [preference, detectedAddress, savePreference],
  );

  const removeCustomAddress = useCallback(
    (address: string) => {
      const selected = preference.selectedCustomAddress;
      savePreferenceFromPicker(
        {
          customAddresses: preference.customAddresses.filter(
            (saved) => saved !== address,
          ),
          selectedCustomAddress: selected === address ? null : selected,
        },
        detectedAddress ??
          (interfaces.status === "ready"
            ? pickDefaultAddress(interfaces.value)
            : null),
      );
    },
    [preference, detectedAddress, interfaces, savePreferenceFromPicker],
  );

  const current = offer.current;
  const expired = current !== null && now >= current.expiresAt;

  // Keep `now` fresh while a code is on screen, and catch up immediately when
  // the window comes back from the background.
  useEffect(() => {
    if (!current) return;
    const tick = () => setNow(Date.now());
    const onVisibilityChange = () => {
      setVisible(isWindowVisible());
      tick();
    };
    // Exact wake-ups for the two moments that change what is shown; the
    // interval is the backstop for timers that stalled while the machine slept.
    const timers = [
      current.expiresAt - OFFER_REFRESH_LEAD_MS,
      current.expiresAt,
    ]
      .map((at) => at - Date.now())
      .filter((delay) => delay > 0)
      .map((delay) => window.setTimeout(tick, delay));
    const interval = window.setInterval(tick, OFFER_CLOCK_TICK_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [current]);

  // Renew the code shortly before it lapses, only while someone can see it.
  useEffect(() => {
    if (!current || offer.generating || !visible) return;
    if (now < current.expiresAt - OFFER_REFRESH_LEAD_MS) return;
    if (noAutoRenewRef.current === current.pairingUrl) return;
    void mint(false, current.pairingUrl);
  }, [current, now, visible, offer.generating, mint]);

  // While a live code is on screen, watch for the phone that scans it. Stops as
  // soon as the device count grows past what it was when the code appeared.
  useEffect(() => {
    if (scanBaseline === null && current && deviceCount !== null) {
      setScanBaseline(deviceCount);
    }
  }, [scanBaseline, current, deviceCount]);

  const waitingForScan =
    current !== null &&
    !expired &&
    scanBaseline !== null &&
    deviceCount !== null &&
    deviceCount <= scanBaseline;

  useEffect(() => {
    if (!waitingForScan) return;
    const interval = window.setInterval(() => {
      if (!isWindowActive()) return;
      void loadDevices({ quiet: true });
    }, DEVICE_POLL_MS);
    return () => window.clearInterval(interval);
  }, [waitingForScan, loadDevices]);

  const requestRevoke = useCallback((device: PairedDevice) => {
    setRevoke({ pending: device, revoking: false, error: null });
  }, []);

  const cancelRevoke = useCallback(() => {
    setRevoke((previous) =>
      previous.revoking ? previous : { ...previous, pending: null },
    );
  }, []);

  const confirmRevoke = useCallback(async () => {
    const device = revoke.pending;
    if (!device) return;
    setRevoke({ pending: device, revoking: true, error: null });
    try {
      await api.revokeDevice(device.id);
      if (!mountedRef.current) return;
      setRevoke({ pending: null, revoking: false, error: null });
      setDevices((previous) =>
        previous.status === "ready"
          ? {
              status: "ready",
              value: previous.value.filter((entry) => entry.id !== device.id),
            }
          : previous,
      );
      await loadDevices({ quiet: true });
    } catch (error) {
      if (!mountedRef.current) return;
      setRevoke({
        pending: null,
        revoking: false,
        error: { name: device.name, message: errorMessage(error) },
      });
    }
  }, [api, revoke.pending, loadDevices]);

  return {
    interfaces,
    customAddresses: preference.customAddresses,
    selectedAddress,
    selectedIsCustom,
    selectAddress,
    selectCustomAddress,
    addCustomAddress,
    removeCustomAddress,
    addressSave,
    reloadInterfaces: loadInterfaces,
    offer,
    expired,
    generate,
    devices,
    reloadDevices: loadDevices,
    revoke,
    requestRevoke,
    cancelRevoke,
    confirmRevoke,
  };
}
