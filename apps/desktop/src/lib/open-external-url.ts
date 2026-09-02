/**
 * Hand `url` to the operating system's browser.
 *
 * The bridge is read per call rather than captured once: it is installed by
 * the desktop shim at startup and absent when the frontend runs in a plain
 * browser (dev, tests), and a caller that captured `undefined` early would
 * stay dead for the rest of the session. Outside the desktop shell there is a
 * real browser to fall back on, so `window.open` finishes the job.
 */
export const openExternalUrl = (url: string): void => {
  if (typeof window === "undefined" || !url) {
    return;
  }

  const openExternal = window.desktop?.openExternalUrl;
  if (openExternal) {
    void openExternal(url);
    return;
  }

  window.open(url, "_blank", "noopener");
};
