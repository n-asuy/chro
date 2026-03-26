import type { TranslationFunction } from "@/i18n";
import { Button } from "@chro/ui/button";
import { LoadingDot } from "@chro/ui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { Link } from "@tanstack/react-router";
import { Archive, PanelLeftClose, Plus } from "lucide-react";
import { ArchivePopover } from "./archive-popover";
import { SessionList } from "./session-list";
import type { ArchivedSession } from "../hooks";
import type { StoredTask } from "../types";

type SessionSidebarContentProps = {
  newSessionUrl: string;
  onNewSessionClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  archivedSessions: ArchivedSession[];
  onRestoreSession: (taskId: string) => Promise<void>;
  showSessionListLoading: boolean;
  sessionsError: string | null;
  sortedTasks: StoredTask[];
  activeTaskId: string | null;
  onLoadTask: (task: StoredTask, selectedRunId?: string) => void;
  onArchiveTask: (task: StoredTask) => Promise<void>;
  onCloseSidebar: () => void;
  sidebarButtonClassName: string;
  t: TranslationFunction;
};

export function SessionSidebarContent({
  newSessionUrl,
  onNewSessionClick,
  archivedSessions,
  onRestoreSession,
  showSessionListLoading,
  sessionsError,
  sortedTasks,
  activeTaskId,
  onLoadTask,
  onArchiveTask,
  onCloseSidebar,
  sidebarButtonClassName,
  t,
}: SessionSidebarContentProps) {
  return (
    <div className="flex h-full flex-col bg-transparent">
      <div className="flex h-11 items-center justify-between bg-transparent px-2">
        <div className="flex items-center gap-2">
          <TooltipProvider delayDuration={120}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to={newSessionUrl}
                  aria-label={t("startNewSessionAria")}
                  onClick={onNewSessionClick}
                  className={sidebarButtonClassName}
                >
                  <Plus className="h-4 w-4" />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {t("newSession")}
              </TooltipContent>
            </Tooltip>
            {archivedSessions.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <ArchivePopover
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Archive"
                          className={sidebarButtonClassName}
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      }
                      archivedSessions={archivedSessions}
                      onRestore={onRestoreSession}
                    />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center">
                  Archive
                </TooltipContent>
              </Tooltip>
            ) : null}
          </TooltipProvider>
          {showSessionListLoading ? (
            <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <LoadingDot isLoading={true} className="h-3.5 w-3.5" />
              <span>{t("sessionListLoading")}</span>
            </div>
          ) : null}
        </div>
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("closeSidebar")}
                onClick={onCloseSidebar}
                className={sidebarButtonClassName}
              >
                <PanelLeftClose className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center">
              {t("closeSidebar")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {sessionsError ? (
        <div className="px-3 py-4">
          <p className="text-xs text-muted-foreground">{sessionsError}</p>
        </div>
      ) : showSessionListLoading ? (
        <div className="px-3 py-4">
          <p className="text-xs text-muted-foreground">
            {t("sessionListLoading")}
          </p>
        </div>
      ) : sortedTasks.length > 0 ? (
        <SessionList
          tasks={sortedTasks}
          activeTaskId={activeTaskId}
          onLoadTask={onLoadTask}
          onArchiveTask={onArchiveTask}
          t={t}
        />
      ) : null}
    </div>
  );
}
