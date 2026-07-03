import { cn } from "@/lib/cn";

/** macOS renders the primary modifier as ⌘; other platforms show "Ctrl". */
const isMac =
  typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");

/** The platform's primary modifier token: ⌘ on macOS, "Ctrl" elsewhere. */
export const MOD_KEY = isMac ? "⌘" : "Ctrl";

interface KeyboardHintProps {
  /**
   * Keys to render, left to right. The literal token `"mod"` is replaced with
   * the platform modifier ({@link MOD_KEY}); every other entry renders verbatim.
   */
  keys: readonly string[];
  className?: string;
}

/**
 * A keyboard shortcut rendered as small <kbd> badges (e.g. `["mod", "N"]` →
 * ⌘ N on macOS, Ctrl N elsewhere). Badges inherit the surrounding text color
 * so the same component reads correctly on a light list row and inside a dark
 * tooltip alike.
 */
export function KeyboardHint({ keys, className }: KeyboardHintProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((key) => (
        <kbd
          key={key}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded font-sans text-[10px] leading-none opacity-60"
        >
          {key === "mod" ? MOD_KEY : key}
        </kbd>
      ))}
    </span>
  );
}
