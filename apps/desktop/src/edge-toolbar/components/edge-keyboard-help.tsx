import { useLanguage } from "@/i18n";
import type { TranslationKey } from "@/i18n";

function Key({ children }: { children: string }) {
  return (
    <kbd
      className="edge-key font-sans"
      data-word={children.length > 1 ? "" : undefined}
    >
      {children}
    </kbd>
  );
}

/**
 * The shortcuts the edge toolbar has, shown in place of the panel's body by
 * the `?` button or key. J/K are listed only while the Unread pager pages.
 */
export function EdgeKeyboardHelp({ paging }: { paging: boolean }) {
  const { t } = useLanguage();
  const rows: { keys: string[]; label: TranslationKey }[] = [
    ...(paging
      ? [{ keys: ["J", "K"], label: "edgeToolbarHelpSessions" as const }]
      : []),
    { keys: ["1", "2", "3"], label: "edgeToolbarHelpOption" },
    { keys: ["←", "→"], label: "edgeToolbarHelpQuestion" },
    { keys: ["?"], label: "edgeToolbarHelpToggle" },
    { keys: ["esc"], label: "edgeToolbarHelpClose" },
  ];
  return (
    <section
      data-edge-help
      className="edge-help flex-1 px-3.5 pb-3.5 pt-3 text-[12px] text-custom-text-300"
    >
      <h3 className="mb-2 text-[13px] font-semibold text-custom-text-100">
        {t("edgeToolbarHelpTitle")}
      </h3>
      <dl>
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt>
              {row.keys.map((key) => (
                <Key key={key}>{key}</Key>
              ))}
            </dt>
            <dd className="text-custom-text-100">{t(row.label)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
