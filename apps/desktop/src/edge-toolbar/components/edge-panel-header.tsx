import { useLanguage } from "@/i18n";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { pagerIndicator } from "../domain/edge-sessions";

/** Progress dots that fit beside the title before the pager shows "3 / 12". */
const MAX_PAGER_DOTS = 7;

/** The Unread pager's position and its J/K steps. */
export interface EdgePagerControls {
  order: readonly string[];
  cursorId: string | null;
  onStep: (delta: 1 | -1) => void;
}

/** A bare question mark, the help button's glyph. */
function QuestionGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8.75 9a3.25 3.25 0 1 1 4.6 2.96c-.83.37-1.35 1.03-1.35 1.94v.6" />
      <circle cx="12" cy="18.1" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Key({ children, word }: { children: string; word?: boolean }) {
  return (
    <kbd className="edge-key font-sans" data-word={word ? "" : undefined}>
      {children}
    </kbd>
  );
}

function PagerPosition({ pager }: { pager: EdgePagerControls }) {
  const { t } = useLanguage();
  const indicator = pagerIndicator(pager.order, pager.cursorId, MAX_PAGER_DOTS);
  if (!indicator) return null;
  const label = t("edgeToolbarPosition", {
    position: indicator.index + 1,
    total: indicator.total,
  });
  if (indicator.kind === "count") {
    return (
      <span
        aria-label={label}
        className="shrink-0 text-[12px] tabular-nums text-custom-text-300"
      >
        {indicator.index + 1} / {indicator.total}
      </span>
    );
  }
  return (
    <span role="img" aria-label={label} className="edge-pager">
      {pager.order.map((id, index) => (
        <i key={id} data-on={index === indicator.index ? "" : undefined} />
      ))}
    </span>
  );
}

/**
 * The panel's header: the session title with the pager's position dots and
 * its controls (J/K, keyboard help, close), and below it the lines the caller
 * passes (status and branch).
 */
export function EdgePanelHeader({
  title,
  pager,
  help,
  onToggleHelp,
  onClose,
  leading,
  children,
}: {
  title: string;
  /** A control before the title (the session's icon). */
  leading?: ReactNode;
  pager?: EdgePagerControls;
  help: boolean;
  onToggleHelp: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useLanguage();
  const index = pager?.cursorId ? pager.order.indexOf(pager.cursorId) : -1;
  const paging = pager !== undefined && pager.order.length > 1;
  return (
    <header className="flex shrink-0 flex-col px-3.5 pt-2">
      <div className="flex h-6 items-center gap-1.5 text-custom-text-100">
        {leading}
        <h2
          title={title}
          className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-0.2px]"
        >
          {title}
        </h2>
        {pager ? <PagerPosition pager={pager} /> : null}
        {paging ? (
          <>
            <button
              type="button"
              data-kind="nav"
              className="edge-hpill"
              disabled={index <= 0}
              aria-label={t("edgeToolbarPrevious")}
              onClick={() => pager.onStep(-1)}
            >
              <ChevronLeft />
              <Key>J</Key>
            </button>
            <button
              type="button"
              data-kind="nav"
              className="edge-hpill"
              disabled={index < 0 || index >= pager.order.length - 1}
              aria-label={t("edgeToolbarNext")}
              onClick={() => pager.onStep(1)}
            >
              <ChevronRight />
              <Key>K</Key>
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="edge-hcircle"
          title={t("edgeToolbarHelp")}
          aria-label={t("edgeToolbarHelp")}
          aria-pressed={help}
          onClick={onToggleHelp}
        >
          <QuestionGlyph />
        </button>
        <button
          type="button"
          data-kind="close"
          className="edge-hpill"
          aria-label={t("edgeToolbarClose")}
          onClick={onClose}
        >
          <X />
          <Key word>esc</Key>
        </button>
      </div>
      {children}
    </header>
  );
}
