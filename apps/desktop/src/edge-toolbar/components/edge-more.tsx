import { type TranslationKey, useLanguage } from "@/i18n";
import type { CSSProperties, ReactNode } from "react";

/** A 24-unit line glyph, drawn like the toolbar's other glyphs. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="edge-glyph"
    >
      {children}
    </svg>
  );
}

const Dot = ({ cx }: { cx: number }) => (
  <circle cx={cx} cy={12} r={1.7} fill="currentColor" stroke="none" />
);

export type MoreItem = "settings" | "feedback" | "usage";

/** The mock's items that chro has, in the mock's order. */
const ITEMS: { id: MoreItem; label: TranslationKey; glyph: ReactNode }[] = [
  {
    id: "settings",
    label: "edgeToolbarSettings",
    glyph: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 2.75v2.5M12 18.75v2.5M2.75 12h2.5M18.75 12h2.5M5.46 5.46l1.77 1.77M16.77 16.77l1.77 1.77M5.46 18.54l1.77-1.77M16.77 7.23l1.77-1.77" />
        <circle cx="12" cy="12" r="6.25" />
      </>
    ),
  },
  {
    id: "feedback",
    label: "edgeToolbarFeedback",
    glyph: (
      <>
        <ellipse cx="12" cy="14" rx="5" ry="6" />
        <path d="M12 8v12M7 14H3.5M20.5 14H17M7.8 10.5 5 8.5M16.2 10.5l2.8-2M7.8 17.5 5 19.5M16.2 17.5l2.8 2" />
        <path d="M9 8.5a3 3 0 0 1 6 0" />
      </>
    ),
  },
  {
    id: "usage",
    label: "edgeToolbarUsage",
    glyph: (
      <>
        <rect x="4" y="12.5" width="3.6" height="7.5" rx="1" />
        <rect x="10.2" y="8" width="3.6" height="12" rx="1" />
        <rect x="16.4" y="4" width="3.6" height="16" rx="1" />
      </>
    ),
  },
];

/** How many items the capsule holds, for its open height. */
export const MORE_ITEM_COUNT = ITEMS.length;

/**
 * The toolbar's last capsule (the mock's "…"): closed it is a round button
 * with three dots; pointing at it or clicking it opens it into a column of
 * items (Settings, Feedback, Usage), the item whose panel is open marked.
 * Closed, the whole capsule is one button: its first click only opens it.
 */
export function EdgeMore({
  open,
  collapsed,
  selected,
  onOpen,
  onItem,
}: {
  open: boolean;
  collapsed: boolean;
  selected: MoreItem | null;
  onOpen: () => void;
  onItem: (item: MoreItem) => void;
}) {
  const { t } = useLanguage();
  return (
    <div
      data-edge-hover={collapsed ? undefined : "more"}
      data-open={open ? "" : undefined}
      aria-hidden={collapsed || undefined}
      className="edge-chrome edge-round edge-more"
      style={{ "--edge-more-items": MORE_ITEM_COUNT } as CSSProperties}
    >
      <button
        type="button"
        tabIndex={collapsed || open ? -1 : undefined}
        aria-label={t("edgeToolbarMore")}
        title={t("edgeToolbarMore")}
        onClick={onOpen}
        className="edge-more-dots"
      >
        <Glyph>
          <Dot cx={5.5} />
          <Dot cx={12} />
          <Dot cx={18.5} />
        </Glyph>
      </button>
      <span className="edge-more-items">
        {ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            tabIndex={open ? undefined : -1}
            title={t(item.label)}
            aria-label={t(item.label)}
            data-selected={selected === item.id ? "" : undefined}
            onClick={() => onItem(item.id)}
            className="edge-more-item"
          >
            <Glyph>{item.glyph}</Glyph>
          </button>
        ))}
      </span>
    </div>
  );
}
