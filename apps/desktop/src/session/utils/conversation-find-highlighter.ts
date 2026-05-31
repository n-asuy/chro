/**
 * DOM text search + match painting for the session conversation find feature.
 *
 * The conversation is arbitrary rendered React (markdown, tool calls, logs),
 * so instead of mutating the DOM (which would fight React's reconciliation) we
 * paint matches with the CSS Custom Highlight API. Ranges from every active
 * find controller are aggregated into two named highlights styled in
 * globals.css:
 *   - `chro-find-match`         — all matches
 *   - `chro-find-match-current` — the currently selected match
 */

const MATCH_HIGHLIGHT = "chro-find-match";
const CURRENT_HIGHLIGHT = "chro-find-match-current";

// Minimal structural types for the CSS Custom Highlight API so this module
// compiles regardless of the DOM lib version in use.
interface HighlightLike {
  clear(): void;
  add(range: Range): void;
}
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}
type HighlightConstructor = new (...ranges: Range[]) => HighlightLike;

function getHighlightApi(): {
  registry: HighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  const scope = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike };
    Highlight?: HighlightConstructor;
  };
  if (scope.CSS?.highlights && typeof scope.Highlight === "function") {
    return { registry: scope.CSS.highlights, Highlight: scope.Highlight };
  }
  return null;
}

export function isHighlightApiSupported(): boolean {
  return getHighlightApi() !== null;
}

type RegistryEntry = { matches: Range[]; current: Range | null };

const controllerRanges = new Map<symbol, RegistryEntry>();
let matchHighlight: HighlightLike | null = null;
let currentHighlight: HighlightLike | null = null;

function rebuild(): void {
  const api = getHighlightApi();
  if (!api) return;

  if (!matchHighlight) {
    matchHighlight = new api.Highlight();
    api.registry.set(MATCH_HIGHLIGHT, matchHighlight);
  }
  if (!currentHighlight) {
    currentHighlight = new api.Highlight();
    api.registry.set(CURRENT_HIGHLIGHT, currentHighlight);
  }

  matchHighlight.clear();
  currentHighlight.clear();
  for (const { matches, current } of controllerRanges.values()) {
    for (const range of matches) matchHighlight.add(range);
    if (current) currentHighlight.add(current);
  }
}

function teardown(): void {
  const api = getHighlightApi();
  if (api) {
    api.registry.delete(MATCH_HIGHLIGHT);
    api.registry.delete(CURRENT_HIGHLIGHT);
  }
  matchHighlight = null;
  currentHighlight = null;
}

/** Register (or replace) the ranges painted by a single find controller. */
export function setHighlightRanges(
  id: symbol,
  matches: Range[],
  current: Range | null,
): void {
  if (!isHighlightApiSupported()) return;
  controllerRanges.set(id, { matches, current });
  rebuild();
}

/** Remove a controller's ranges; tears down the registry when none remain. */
export function clearHighlightRanges(id: symbol): void {
  if (!controllerRanges.delete(id)) return;
  if (controllerRanges.size === 0) {
    teardown();
  } else {
    rebuild();
  }
}

/**
 * Collect ranges for every occurrence of `query` within `container`, in
 * document order. Matching is case-insensitive and per text node — matches
 * that straddle element boundaries (e.g. across bold spans) are not detected,
 * which is an acceptable trade-off for arbitrary rendered content. Text in
 * collapsed/hidden subtrees is skipped so match counts reflect what the user
 * can actually navigate to.
 */
export function collectMatchRanges(
  container: HTMLElement,
  query: string,
): Range[] {
  const ranges: Range[] = [];
  const needle = query.toLowerCase();
  if (!needle) return ranges;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      if (!text || !text.toLowerCase().includes(needle)) {
        return NodeFilter.FILTER_REJECT;
      }
      // Skip text inside collapsed / display:none subtrees: such nodes have no
      // offset parent and cannot be scrolled into view.
      const parent = node.parentElement;
      if (!parent || parent.offsetParent === null) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? "";
    const lower = text.toLowerCase();
    let from = lower.indexOf(needle);
    while (from !== -1) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
      from = lower.indexOf(needle, from + needle.length);
    }
  }

  return ranges;
}
