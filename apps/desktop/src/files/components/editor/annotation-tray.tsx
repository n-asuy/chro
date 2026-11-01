import { useLanguage } from "@/i18n";
import {
  NEW_SESSION_TARGET,
  useSessionComposerTargets,
} from "@/workspace-layout/hooks/use-session-composer-targets";
import { Button } from "@chro/ui/button";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PreviewAnnotations } from "../../hooks/use-preview-annotations";

/**
 * Side column of the HTML preview while annotating: the comments made so far
 * and where to send them. It sits beside the frame rather than over it, so it
 * never hides the element being commented on.
 */
export function AnnotationTray({
  annotations,
}: {
  annotations: PreviewAnnotations;
}) {
  const { t } = useLanguage();
  const { targets, deliver } = useSessionComposerTargets();
  const [targetId, setTargetId] = useState<string>(
    targets[0]?.tabId ?? NEW_SESSION_TARGET,
  );

  // Keep the choice valid when the chosen session tab is closed.
  useEffect(() => {
    if (
      targetId !== NEW_SESSION_TARGET &&
      !targets.some((target) => target.tabId === targetId)
    ) {
      setTargetId(targets[0]?.tabId ?? NEW_SESSION_TARGET);
    }
  }, [targets, targetId]);

  const { notes, page } = annotations;

  const send = () => {
    if (!page) return;
    deliver(targetId, (composer) => composer.addAnnotationsPart(page));
    annotations.clear();
    annotations.setActive(false);
  };

  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-l border-border bg-custom-background-100"
      aria-label={t("annotationsTrayTitle")}
    >
      <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
        <span className="text-[12.5px] font-semibold text-custom-text-100">
          {t("annotationsTrayTitle")}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {notes.length}
        </span>
        {notes.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-[11px] text-muted-foreground"
            onClick={annotations.clear}
          >
            {t("annotationsClear")}
          </Button>
        )}
      </div>
      <p className="px-3 pb-2 text-[11.5px] text-muted-foreground">
        {t("annotationsTrayHint")}
      </p>
      <ol className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2">
        {notes.length === 0 && (
          <li className="mx-1 rounded-md border border-dashed border-border px-3 py-3 text-center text-[12px] text-muted-foreground">
            {t("annotationsTrayEmpty")}
          </li>
        )}
        {notes.map((note, index) => (
          <li
            key={`${index}-${note.selector}`}
            className="group relative rounded-md border border-border px-2.5 py-2"
          >
            <div className="mb-0.5 flex min-w-0 items-center gap-1.5 pr-5">
              <span className="inline-flex size-[18px] shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10.5px] font-semibold leading-none text-white dark:bg-blue-500">
                {index + 1}
              </span>
              <span
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={note.selector}
              >
                {note.element}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-[12.5px] text-custom-text-100">
              {note.comment}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 size-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={t("annotationsRemove")}
              onClick={() => annotations.removeNote(index)}
            >
              <X className="size-3" />
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-2 border-t border-border px-3 pb-3 pt-2.5">
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          {t("annotationsTargetLabel")}
          <select
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            className="h-7 min-w-0 flex-1 rounded-md border border-custom-border-200 bg-custom-background-100 px-1.5 text-[12px] text-custom-text-100 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {targets.length > 0 && (
              <optgroup label={t("annotationsTargetOpenSessions")}>
                {targets.map((target) => (
                  <option key={target.tabId} value={target.tabId}>
                    {target.title}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={NEW_SESSION_TARGET}>
              {t("annotationsTargetNewSession")}
            </option>
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          className="h-7 text-[12px]"
          disabled={!page}
          onClick={send}
        >
          {t("annotationsAddToComposer")}
        </Button>
      </div>
    </aside>
  );
}
