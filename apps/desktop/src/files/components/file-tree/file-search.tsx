
import { useCallback } from "react";
import { Search } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { useLanguage } from "@/i18n";
import { useFilesCommandPaletteStore } from "../../state/files-command-palette-store";

export const FileSearch = () => {
  const { t } = useLanguage();
  const openPalette = useFilesCommandPaletteStore((state) => state.open);

  const handleClick = useCallback(() => {
    openPalette();
  }, [openPalette]);

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            className="font-workspace text-[12px] leading-[1.35] inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-[3px] px-2 text-custom-sidebar-text-300 transition hover:bg-custom-sidebar-background-80 hover:text-custom-sidebar-text-100"
            aria-label={t("searchFiles")}
          >
            <Search className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center">
          {t("searchFiles")} (⌘P)
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
