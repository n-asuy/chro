import { useLanguage } from "@/i18n";
import { MousePointerClick } from "lucide-react";
import type { AnnotationsContextEntry } from "../types/context";

/**
 * Comments a user pinned on a rendered page, as sent with a message. Each row
 * pairs the comment with the element it targets, which is what the agent acts
 * on and what the user needs to recognise the request later.
 */
export const PageAnnotationsCard = ({
  entry,
}: {
  entry: AnnotationsContextEntry;
}) => {
  const { t } = useLanguage();
  const name = entry.path.split("/").pop() || entry.path;

  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div
        className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5 text-xs text-muted-foreground"
        title={entry.path}
      >
        <MousePointerClick className="h-3 w-3 shrink-0" />
        <span className="truncate">
          {t("pageAnnotationsHeading", { count: entry.notes.length, name })}
        </span>
      </div>
      <ol className="divide-y divide-border">
        {entry.notes.map((note, index) => (
          <li
            key={`${index}-${note.selector}`}
            className="flex items-start gap-2 px-2.5 py-1.5"
          >
            <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-semibold leading-none text-white dark:bg-blue-500">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                {note.comment}
              </p>
              <p
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={note.selector}
              >
                {note.element} · {note.selector}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
};
