/** The subset of a keydown the composer needs to decide what a key means. */
export interface PromptKeystroke {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  /** Required: one of these turns the Return into a submit. */
  metaKey: boolean;
  ctrlKey: boolean;
  /** Set while an IME conversion owns the keystroke. */
  isComposing: boolean;
  keyCode: number;
}

/** A keydown consumed by an IME reports this legacy code on every platform. */
const IME_KEY_CODE = 229;

/**
 * Cmd/Ctrl+Return submits the prompt; a bare Return inserts a newline.
 *
 * The composer holds multi-line prompts, so Return has to stay a newline: this
 * is what every comparable multi-line field in the app does (feedback, the
 * commit message, onboarding) and what the reference client does for its own
 * prompt composer. Both modifiers are accepted rather than branching on the
 * platform, which keeps the decision a pure function of the keystroke — the
 * chord each platform's users reach for works either way.
 */
export const shouldSubmitPrompt = (e: PromptKeystroke): boolean => {
  if (e.key !== "Enter") return false;
  if (!e.metaKey && !e.ctrlKey) return false;
  // A Return that belongs to an IME conversion is never a submit, modifier or
  // not. `isComposing` alone is not enough: WebKit — which is what the desktop
  // app renders in — ends composition *before* the confirming keydown, leaving
  // only the legacy keyCode to identify it.
  if (e.isComposing || e.keyCode === IME_KEY_CODE) return false;
  return !e.shiftKey && !e.altKey;
};
