import type { RefObject } from "react";
import { useEffect } from "react";

export const useIntersectionObserver = (
  containerRef: RefObject<HTMLDivElement | null>,
  elementRef: HTMLElement | null,
  callback: (() => void) | undefined,
  rootMargin?: string,
) => {
  useEffect(() => {
    if (!elementRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const lastEntry = entries[entries.length - 1];
        if (lastEntry?.isIntersecting && callback) {
          callback();
        }
      },
      {
        root: containerRef?.current ?? undefined,
        rootMargin,
      },
    );

    observer.observe(elementRef);

    return () => {
      observer.unobserve(elementRef);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef?.current, elementRef, rootMargin, callback]);
};
