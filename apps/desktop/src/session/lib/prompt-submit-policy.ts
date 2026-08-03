/** The subset of a keydown the composer needs to decide what a key means. */
export interface PromptKeystroke {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  /** Accepted but not required: Cmd/Ctrl+Return submits like a bare Return. */
  metaKey: boolean;
  ctrlKey: boolean;
  /** Set while an IME conversion owns the keystroke. */
  isComposing: boolean;
  keyCode: number;
}

/** A keydown consumed by an IME reports this legacy code on every platform. */
const IME_KEY_CODE = 229;

/**
 * Return submits the prompt; Shift/Alt+Return inserts a newline. This is the
 * chat convention the rest of the app already follows (the AskUserQuestion
 * "other" field, every reference client), so the composer must not diverge.
 */
export const shouldSubmitPrompt = (e: PromptKeystroke): boolean => {
  if (e.key !== "Enter") return false;
  // The Return that confirms an IME conversion belongs to the IME, not to us.
  // `isComposing` alone is not enough: WebKit — which is what the desktop app
  // renders in — ends composition *before* that keydown, leaving only the
  // legacy keyCode to identify it.
  if (e.isComposing || e.keyCode === IME_KEY_CODE) return false;
  return !e.shiftKey && !e.altKey;
};
