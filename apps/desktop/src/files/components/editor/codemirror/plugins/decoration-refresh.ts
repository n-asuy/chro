/**
 * Shared "rebuild decorations now" signal for prose decoration StateFields.
 *
 * Prose plugins used to rebuild on `tr.effects.length > 0`, which fired for
 * ANY effect in the transaction — search queries, the bubble-menu state (which
 * updates on every selection change), scroll-into-view, table raw-edit, config
 * reconfigure. That made a single unrelated effect rebuild all ~13 decoration
 * fields over the whole document. Fields now rebuild only for this dedicated
 * effect, dispatched intentionally after init / content reset / async widget
 * loads (image dimensions, diagram render, theme change).
 */
import type { Transaction } from "@codemirror/state";
import { StateEffect } from "@codemirror/state";

/** Ask every prose decoration field to do a full rebuild. */
export const refreshDecorationsEffect = StateEffect.define<void>();

/** Whether `tr` carries an intentional decoration-refresh request. */
export function hasDecorationRefresh(tr: Transaction): boolean {
  return tr.effects.some((effect) => effect.is(refreshDecorationsEffect));
}
