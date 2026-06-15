import type { TranslationFunction } from "@/i18n";
import { Loader2, Pause } from "lucide-react";

interface SessionActivityIndicatorProps {
  /** The agent is blocked on an AskUserQuestion, waiting for the user. */
  awaitingInput: boolean;
  t: TranslationFunction;
  className?: string;
}

/**
 * Right-aligned status icon for a running session row.
 *
 * While the agent is actively working it spins; once it blocks on an
 * AskUserQuestion it switches to a static pause glyph so the row reads as
 * "waiting for you" rather than "still busy".
 */
export function SessionActivityIndicator({
  awaitingInput,
  t,
  className = "h-3.5 w-3.5",
}: SessionActivityIndicatorProps) {
  if (awaitingInput) {
    return (
      <span
        className="inline-flex items-center text-custom-primary-100"
        aria-label={t("sessionAwaitingInput")}
      >
        <Pause className={className} aria-hidden="true" />
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center text-custom-primary-100"
      aria-label={t("waitingMessage")}
    >
      <Loader2 className={`${className} animate-spin`} aria-hidden="true" />
    </span>
  );
}
