import type { BoardColumn } from "@/kanban/types";

import type { KanbanColumnIconVariant } from "./column-icon";

const COLUMN_ICON_VARIANTS: Record<string, KanbanColumnIconVariant> = {
  planning: "dotted",
  backlog: "dotted",
  ready: "dotted",
  todo: "dotted",
  progress: "semi",
  "in-progress": "semi",
  started: "semi",
  doing: "semi",
  review: "outline",
  qa: "outline",
  feedback: "outline",
  "in-review": "outline",
  cancelled: "cross",
  done: "check",
  complete: "check",
  completed: "check",
  shipped: "check",
};

const normalizeKey = (value?: string) =>
  value?.trim().toLowerCase().replace(/\s+/g, "-") ?? "";

const resolveVariantFromKeys = (
  ...keys: Array<string | undefined>
): KanbanColumnIconVariant | undefined => {
  for (const key of keys) {
    const normalized = normalizeKey(key);
    if (normalized && COLUMN_ICON_VARIANTS[normalized]) {
      return COLUMN_ICON_VARIANTS[normalized];
    }
  }
  return undefined;
};

export const getColumnIconVariant = (
  column: Pick<BoardColumn, "id" | "title">,
): KanbanColumnIconVariant =>
  resolveVariantFromKeys(column.id, column.title) ?? "outline";

