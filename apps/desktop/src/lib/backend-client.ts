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

/** Absolute URL for a backend path; URLs that already carry a scheme pass through. */
export const backendUrl = (path: string): string =>
  /^[a-z][a-z\d+.-]*:/i.test(path)
    ? path
    : `${resolveBackendBaseUrl().replace(/\/$/, "")}${path}`;

export const desktopFetch = async <T>(
  path: string,
  init?: RequestInit,
): Promise<T> => {
  const response = await fetch(backendUrl(path), init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }
  if (response.status === 204) {
    return {} as T;
  }
  return (await response.json()) as T;
};
