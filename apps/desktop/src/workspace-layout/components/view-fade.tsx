import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";

interface ViewFadeProps {
  /**
   * Identifies the view currently shown. Changing it replays the fade so the
   * incoming content materializes instead of hard-cutting in. Pass the same
   * value that selects the rendered subtree (e.g. the active dock panel, or the
   * projects/inbox toggle).
   */
  viewKey: string;
  className?: string;
  children: ReactNode;
}

/**
 * Fade a swapped view in on entry. Dock panels and the projects/inbox switcher
 * mount a different subtree the instant their selector changes, which reads as
 * an abrupt snap. Re-keying this wrapper on `viewKey` remounts it, so the new
 * content fades up from transparent. Opacity only — never a translate — so the
 * layout does not move (the desktop must not shift content without explicit
 * user intent). Honors prefers-reduced-motion by skipping the fade.
 */
export function ViewFade({ viewKey, className, children }: ViewFadeProps) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      key={viewKey}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
