import { useLanguage } from "@/i18n";
import { useRightDockStore } from "@/workspace-layout/state/right-dock-store";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { ArrowLeft } from "lucide-react";

/**
 * Returns the right dock to the file tree. Surfaced in the header of the
 * search and source-control panels, which are reached from the file tree
 * header icons and otherwise have no visible way back.
 */
export function DockBackButton() {
  const { t } = useLanguage();
  const setActivePanel = useRightDockStore((s) => s.setActivePanel);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setActivePanel("filetree")}
            className="inline-flex h-7 min-w-7 items-center justify-center rounded-[3px] px-2 text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"
            aria-label={t("backToFiles")}
          >
            <ArrowLeft className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {t("backToFiles")}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
