const resolveBackendBaseUrl = (): string => {
  if (
    typeof window !== "undefined" &&
    typeof window.__CHRO_RUNTIME__ !== "undefined"
  ) {
    const runtimeUrl = window.__CHRO_RUNTIME__?.backendUrl;
    if (runtimeUrl) {
      return runtimeUrl;
    }
  }
  if (import.meta.env.VITE_DESKTOP_BACKEND_URL) {
    return import.meta.env.VITE_DESKTOP_BACKEND_URL;
  }
  return typeof window !== "undefined" ? window.location.origin : "";
};

export const getBackendBaseUrl = (): string => resolveBackendBaseUrl();

export const desktopFetch = async <T>(
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const baseUrl = resolveBackendBaseUrl().replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }
  if (response.status === 204) {
    return {} as T;
  }
  return (await response.json()) as T;
};
