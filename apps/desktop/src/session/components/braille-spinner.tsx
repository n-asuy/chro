import { cn } from "@/lib/cn";
import { useEffect, useState } from "react";

const BRAILLE_FRAMES = [
  "\u280b",
  "\u2819",
  "\u2839",
  "\u2838",
  "\u283c",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280f",
] as const;

interface BrailleSpinnerProps {
  className?: string;
  intervalMs?: number;
}

export function BrailleSpinner({
  className,
  intervalMs = 90,
}: BrailleSpinnerProps) {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setFrameIndex((index) => (index + 1) % BRAILLE_FRAMES.length);
    }, intervalMs);

    return () => window.clearInterval(timerId);
  }, [intervalMs]);

  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex w-[1ch] justify-center font-mono", className)}
    >
      {BRAILLE_FRAMES[frameIndex]}
    </span>
  );
}
