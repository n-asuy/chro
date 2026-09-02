import { openExternalUrl } from "@/lib/open-external-url";
import { useEffect } from "react";

const isModifiedClick = (event: MouseEvent) =>
  event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

const findAnchorElement = (
  target: EventTarget | null,
): HTMLAnchorElement | null => {
  let current = target instanceof Element ? target : null;
  while (current) {
    if (current instanceof HTMLAnchorElement && current.href) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
};

const shouldOpenExternally = (anchor: HTMLAnchorElement) => {
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) {
    return false;
  }

  try {
    const parsed = new URL(anchor.href, window.location.href);
    if (parsed.origin === window.location.origin) {
      return false;
    }
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Sends every left click on an external `<a>` to the system browser. The
 * desktop shell has no place to put a second page — `target="_blank"` opens
 * nothing there — so the anchor never navigates on its own.
 */
export function ExternalLinkHandler() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handleClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        isModifiedClick(event)
      ) {
        return;
      }

      const anchor = findAnchorElement(event.target);
      if (!anchor || !shouldOpenExternally(anchor)) {
        return;
      }

      event.preventDefault();
      openExternalUrl(anchor.href);
    };

    document.addEventListener("click", handleClick);
    return () => {
      document.removeEventListener("click", handleClick);
    };
  }, []);

  return null;
}
