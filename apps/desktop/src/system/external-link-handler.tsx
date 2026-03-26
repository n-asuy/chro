
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

export function ExternalLinkHandler() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const openExternal = window.desktop?.openExternalUrl;
    if (!openExternal) {
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
      void openExternal(anchor.href);
    };

    document.addEventListener("click", handleClick);
    return () => {
      document.removeEventListener("click", handleClick);
    };
  }, []);

  return null;
}
