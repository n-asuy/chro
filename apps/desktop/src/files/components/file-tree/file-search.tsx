import { useLanguage } from "@/i18n";
import { useRightDockStore } from "@/workspace-layout/state/right-dock-store";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { Search } from "lucide-react";

export const FileSearch = () => {
  const { t } = useLanguage();
  const focusSearchPanel = useRightDockStore((state) => state.focusSearchPanel);

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={focusSearchPanel}
            className="font-workspace text-[12px] leading-[1.35] inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-[3px] px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100"
            aria-label={t("searchFiles")}
          >
            <Search className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {t("searchFiles")} (⌘K)
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
