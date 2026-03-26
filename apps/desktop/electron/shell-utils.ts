import { shell } from "electron";

export const openExternalUrl = (targetUrl: string | null | undefined) => {
  if (!targetUrl) return;
  shell.openExternal(targetUrl).catch((error) => {
    console.warn(`[desktop] Failed to open external url: ${targetUrl}`, error);
  });
};
