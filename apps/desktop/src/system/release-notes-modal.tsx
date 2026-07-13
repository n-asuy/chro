import { useLanguage } from "@/i18n";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@chro/ui/dialog";
import { Loader2, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import {
  CHANGELOG_RELEASES,
  CURRENT_VERSION,
  type ChangelogRelease,
  isCurrentVersion,
  splitInlineCode,
} from "./changelog";
import { formatVersion } from "./update-popup-reducer";
import type { Updater } from "./use-updater";

export function ReleaseNotesModal({
  open,
  onOpenChange,
  updater,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  updater: Updater;
}) {
  const { t } = useLanguage();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-full max-w-[560px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b border-border/60 px-5 py-4 pr-12 text-left">
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            {t("releaseNotesTitle")}
            {CURRENT_VERSION ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                {formatVersion(CURRENT_VERSION)}
              </span>
            ) : null}
          </DialogTitle>
          {updater.supported ? <CheckForUpdates updater={updater} /> : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {CHANGELOG_RELEASES.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("releaseNotesEmpty")}
            </p>
          ) : (
            <ol className="space-y-5">
              {CHANGELOG_RELEASES.map((release) => (
                <ReleaseEntry key={release.version} release={release} />
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Quiet, secondary re-check affordance in the modal header. */
function CheckForUpdates({ updater }: { updater: Updater }) {
  const { t } = useLanguage();
  const checking = updater.actionState === "retrying";
  return (
    <button
      type="button"
      onClick={updater.check}
      disabled={updater.actionState !== "idle"}
      className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
    >
      {checking ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <RotateCcw className="h-3 w-3" />
      )}
      {t("releaseCheckAction")}
    </button>
  );
}

function ReleaseEntry({ release }: { release: ChangelogRelease }) {
  const { t } = useLanguage();
  const current = isCurrentVersion(release.version);
  return (
    <li>
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold tabular-nums">
          {formatVersion(release.version)}
        </h3>
        {current ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            {t("releaseNotesCurrentBadge")}
          </span>
        ) : null}
      </div>
      {release.notes.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {release.notes.map((note) => (
            <li
              key={note}
              className="flex gap-2 text-[13px] leading-relaxed text-foreground/85"
            >
              <span
                aria-hidden
                className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50"
              />
              <span className="min-w-0">{renderNote(note)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Render a note's plain / inline-code runs, styling `` `code` `` spans. */
function renderNote(note: string): ReactNode {
  // Key each run by its byte offset in the note: stable and unique across the
  // fixed string, without keying on the array index.
  let offset = 0;
  return splitInlineCode(note).map((segment) => {
    const key = `${offset}`;
    offset += segment.text.length + (segment.code ? 2 : 0);
    return segment.code ? (
      <code
        key={key}
        className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/90"
      >
        {segment.text}
      </code>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
}
