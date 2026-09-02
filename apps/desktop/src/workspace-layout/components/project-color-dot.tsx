import { cn } from "@/lib/cn";

/**
 * 6px identity dot for a project. `color` is any CSS color value (usually
 * from `resolveProjectColor`). The dot is purely decorative; surfaces that
 * need the project name for accessibility render it as text alongside.
 */
export function ProjectColorDot({
  color,
  className,
}: {
  color: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        className,
      )}
      style={{ backgroundColor: color }}
    />
  );
}
