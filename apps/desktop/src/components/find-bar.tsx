/**
 * Presentational find bar shared by the file editor and the session
 * conversation.
 *
 * It owns only the input/navigation chrome — focus management plus
 * Enter / Shift+Enter / Escape handling — and delegates the actual search
 * (highlighting, match navigation) to its host via callbacks. Both surfaces
 * render the exact same markup so the find UI stays identical everywhere.
 */

import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";

interface FindBarProps {
  query: string;
  onQueryChange: (next: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  /** Optional "current/total" style label rendered next to the input. */
  matchLabel?: string | null;
  placeholder?: string;
  ariaLabel?: string;
  /**
   * Bumping this number re-focuses and selects the input. Hosts use it to
   * refocus when the bar is already mounted (e.g. pressing the find shortcut
   * again).
   */
  focusSignal?: number;
}

export function FindBar({
  query,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
  matchLabel,
  placeholder = "Find...",
  ariaLabel = "Find",
  focusSignal,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus and select on mount, and whenever the host requests focus again.
  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    }
  }, [focusSignal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="chro-find-bar">
      <div className="chro-find-input-wrap">
        <span className="chro-find-icon">
          <Search size={16} strokeWidth={2} />
        </span>
        <input
          ref={inputRef}
          type="search"
          className="chro-find-input"
          placeholder={placeholder}
          value={query}
          spellCheck={false}
          autoComplete="off"
          aria-label={ariaLabel}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      {matchLabel != null ? (
        <span className="chro-find-count">{matchLabel}</span>
      ) : null}
      <div className="chro-find-actions">
        <button
          type="button"
          className="chro-find-icon-btn"
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onPrevious();
            inputRef.current?.focus();
          }}
        >
          <ArrowUp size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="chro-find-icon-btn"
          title="Next match (Enter)"
          aria-label="Next match"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onNext();
            inputRef.current?.focus();
          }}
        >
          <ArrowDown size={16} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="chro-find-icon-btn chro-find-close"
          title="Close (Esc)"
          aria-label="Close find bar"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
