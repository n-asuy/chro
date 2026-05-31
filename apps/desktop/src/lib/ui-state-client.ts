import { desktopFetch, getBackendBaseUrl } from "./backend-client";

type UiStateResponse = {
  ui_state: Record<string, unknown>;
};

let cache: Record<string, unknown> = {};
let initialized = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWrites: Record<string, unknown> = {};

const DEBOUNCE_MS = 500;

export async function loadUiState(): Promise<void> {
  try {
    const res = await desktopFetch<UiStateResponse>("/rpc/ui-state");
    cache = res.ui_state;
  } catch {
    cache = {};
  }
  initialized = true;
}

function flushPendingWrites(): void {
  if (Object.keys(pendingWrites).length === 0) return;
  const payload = { ...pendingWrites };
  pendingWrites = {};
  desktopFetch<UiStateResponse>("/rpc/ui-state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then((res) => {
      cache = res.ui_state;
    })
    .catch(() => {
      // Merge failed writes back for next flush
    });
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPendingWrites, DEBOUNCE_MS);
}

export function getUiValue<T>(key: string): T | null {
  if (!initialized) return null;
  const val = cache[key];
  return val === undefined ? null : (val as T);
}

export function setUiValue(key: string, value: unknown): void {
  cache[key] = value;
  pendingWrites[key] = value;
  scheduleSave();
}

export function removeUiValue(key: string): void {
  delete cache[key];
  pendingWrites[key] = null;
  scheduleSave();
}

export function isUiStateReady(): boolean {
  return initialized;
}

/**
 * Synchronously send any pending writes to the backend, bypassing the
 * 500 ms debounce. Uses `fetch` with `keepalive: true` so the request
 * survives an immediate page reload. Call this from explicit user
 * actions where losing the write would be visible (e.g. closing a tab
 * before reload).
 */
export function flushUiState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (Object.keys(pendingWrites).length === 0) return;
  const payload = { ...pendingWrites };
  pendingWrites = {};
  const baseUrl = getBackendBaseUrl().replace(/\/$/, "");
  fetch(`${baseUrl}/rpc/ui-state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  })
    .then(async (res) => {
      if (!res.ok) return;
      try {
        const result = (await res.json()) as UiStateResponse;
        cache = result.ui_state;
      } catch {
        // ignore
      }
    })
    .catch(() => {
      // best-effort
    });
}

if (typeof window !== "undefined") {
  const onLeave = () => flushUiState();
  window.addEventListener("pagehide", onLeave);
  window.addEventListener("beforeunload", onLeave);
}
