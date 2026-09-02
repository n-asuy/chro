/**
 * Shared "rebuild decorations now" signal for prose decoration StateFields.
 *
 * Prose plugins used to rebuild on `tr.effects.length > 0`, which fired for
 * ANY effect in the transaction — search queries, the bubble-menu state (which
 * updates on every selection change), scroll-into-view, table raw-edit, config
 * reconfigure. That made a single unrelated effect rebuild all ~13 decoration
 * fields over the whole document. Fields now rebuild only for the two events
 * that can actually change what they render: an intentional refresh request
 * (init / content reset / async widget loads) and the parse moving forward.
 */
import { syntaxTree } from "@codemirror/language";
import type { Transaction } from "@codemirror/state";
import { StateEffect } from "@codemirror/state";

/** Ask every prose decoration field to do a full rebuild. */
export const refreshDecorationsEffect = StateEffect.define<void>();

/** Whether `tr` carries an intentional decoration-refresh request. */
function hasDecorationRefresh(tr: Transaction): boolean {
  return tr.effects.some((effect) => effect.is(refreshDecorationsEffect));
}

/**
 * Whether `tr` extended the syntax tree over text that was unparsed before.
 *
 * A state starts with only the first ~3000 characters parsed and the background
 * parse worker extends the tree as the user scrolls, committing each chunk in a
 * transaction that changes nothing but the language state. Decorations built
 * from the tree must be rebuilt then, otherwise every block below the initial
 * parse window (tables, fenced code, callouts, math) stays raw markdown until
 * the next edit.
 */
function parseAdvanced(tr: Transaction): boolean {
  return syntaxTree(tr.state).length > syntaxTree(tr.startState).length;
}

/** Whether a prose decoration field has to rebuild for `tr`. */
export function needsDecorationRebuild(tr: Transaction): boolean {
  return hasDecorationRefresh(tr) || parseAdvanced(tr);
}
