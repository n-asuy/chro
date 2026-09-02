/**
 * Dev-only UI instrumentation.
 *
 * Listens at the document level so every interaction is recorded without
 * touching individual components. Interactions that never reach the backend
 * -- switching panels, keyboard shortcuts, moving between windows -- only
 * exist here, and they are exactly the ones that answer "which parts of the
 * app do I actually use".
 *
 * Typed text is deliberately not recorded: a keystroke is only captured when
 * it carries a modifier or is a navigation key, so this can never become a
 * transcript of what was written into the app.
 */

import type { AnyRouter } from "@tanstack/react-router";

import { isDevEventsEnabled, recordDevEvent } from "./dev-events";

const MAX_LABEL_CHARS = 60;
const MAX_PATH_DEPTH = 5;

/** Elements that represent an action rather than the pixel that was hit. */
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[role]",
  "[data-slot]",
].join(",");

/** Keys worth recording on their own: navigation, not content. */
const NAVIGATION_KEYS = new Set([
  "Escape",
  "Tab",
  "Enter",
  "ArrowUp",
  "ArrowDown",
]);

/** Sources of a human-readable name for an element, in priority order. */
export interface LabelSources {
  ariaLabel?: string | null;
  title?: string | null;
  text?: string | null;
  placeholder?: string | null;
}

export function collapseLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LABEL_CHARS
    ? `${flat.slice(0, MAX_LABEL_CHARS)}…`
    : flat;
}

/**
 * An explicit label beats visible text, which beats a placeholder. Whitespace
 * -only candidates are skipped so a wrapper element does not win with "".
 */
export function pickLabel(sources: LabelSources): string | undefined {
  for (const candidate of [
    sources.ariaLabel,
    sources.title,
    sources.text,
    sources.placeholder,
  ]) {
    if (!candidate) continue;
    const label = collapseLabel(candidate);
    if (label.length > 0) return label;
  }
  return undefined;
}

/**
 * Ancestor chain as `tag#id` segments, root-first. Class names are omitted:
 * they are utility classes here and carry no information about which surface
 * the element belongs to.
 */
export function formatElementPath(
  segments: Array<{ tag: string; id?: string }>,
): string {
  return segments
    .slice(-MAX_PATH_DEPTH)
    .map((segment) =>
      segment.id ? `${segment.tag}#${segment.id}` : segment.tag,
    )
    .join(">");
}

function elementLabel(element: Element): string | undefined {
  return pickLabel({
    ariaLabel: element.getAttribute("aria-label"),
    title: element.getAttribute("title"),
    text: element.textContent,
    placeholder: element.getAttribute("placeholder"),
  });
}

function elementPath(element: Element): string {
  const segments: Array<{ tag: string; id?: string }> = [];
  let current: Element | null = element;

  while (current && segments.length < MAX_PATH_DEPTH) {
    segments.unshift({
      tag: current.tagName.toLowerCase(),
      id: current.id || undefined,
    });
    current = current.parentElement;
  }

  return formatElementPath(segments);
}

/** Describe what was interacted with, in terms a human can read back later. */
export function describeElement(target: Element): Record<string, unknown> {
  const element = target.closest(INTERACTIVE_SELECTOR) ?? target;
  const described: Record<string, unknown> = {
    tag: element.tagName.toLowerCase(),
    path: elementPath(element),
  };

  const role = element.getAttribute("role");
  if (role) described.role = role;

  const label = elementLabel(element);
  if (label) described.label = label;

  const testState = element.getAttribute("data-state");
  if (testState) described.state = testState;

  if (element.id) described.id = element.id;

  return described;
}

/**
 * Normalized shortcut description, or `null` when the keystroke is plain text
 * input and must not be recorded.
 */
export function describeKeyCombo(event: KeyboardEvent): string | null {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("meta");
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");

  const hasCommandModifier = event.metaKey || event.ctrlKey || event.altKey;

  if (!hasCommandModifier && !NAVIGATION_KEYS.has(event.key)) {
    return null;
  }

  // A bare modifier press is noise, not a shortcut.
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) {
    return null;
  }

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return [...modifiers, key].join("+");
}

/**
 * Attach the listeners. Returns a disposer; a no-op when recording is off, so
 * callers do not need their own guard.
 */
export function installDevAutocapture(options?: {
  router?: AnyRouter;
}): () => void {
  if (!isDevEventsEnabled()) {
    return () => {};
  }

  const disposers: Array<() => void> = [];

  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    recordDevEvent("ui.click", describeElement(target));
  };
  document.addEventListener("click", onClick, { capture: true });
  disposers.push(() =>
    document.removeEventListener("click", onClick, { capture: true }),
  );

  const onKeyDown = (event: KeyboardEvent) => {
    const combo = describeKeyCombo(event);
    if (!combo) return;
    const target = event.target;
    recordDevEvent("ui.key", {
      combo,
      tag: target instanceof Element ? target.tagName.toLowerCase() : undefined,
    });
  };
  document.addEventListener("keydown", onKeyDown, { capture: true });
  disposers.push(() =>
    document.removeEventListener("keydown", onKeyDown, { capture: true }),
  );

  const onVisibility = () => {
    recordDevEvent("ui.visibility", { state: document.visibilityState });
  };
  document.addEventListener("visibilitychange", onVisibility);
  disposers.push(() =>
    document.removeEventListener("visibilitychange", onVisibility),
  );

  const router = options?.router;
  if (router) {
    let from = router.state.location.pathname;
    const unsubscribe = router.subscribe("onResolved", () => {
      const to = router.state.location.pathname;
      recordDevEvent("ui.route", { from, to });
      from = to;
    });
    disposers.push(unsubscribe);
  }

  return () => {
    for (const dispose of disposers) {
      dispose();
    }
  };
}
