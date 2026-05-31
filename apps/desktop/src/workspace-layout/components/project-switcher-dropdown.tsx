import { WorkspaceOpenDialog } from "@/components/dialogs/workspace-open-dialog";
import { prepareWorkspace } from "@/lib/open-workspace";
import {
  type RecentWorkspace,
  getRecentWorkspaces,
} from "@/lib/workspace-history";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";

interface ProjectSwitcherDropdownProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

const sanitizePath = (path: string): string => {
  if (!path) return "";
  const normalized = path.replace(/\\+/g, "/");
  if (/^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+/g, "/").replace(/\/$/, "");
};

const folderLabelFromPath = (path: string): string => {
  const sanitized = sanitizePath(path);
  if (!sanitized) return path;
  if (/^[a-zA-Z]:\/$/.test(sanitized)) {
    return sanitized;
  }
  const segments = sanitized.split("/");
  return segments.pop() || sanitized;
};

export function ProjectSwitcherDropdown({
  open,
  onOpenChange,
  trigger,
  align = "start",
  side = "bottom",
}: ProjectSwitcherDropdownProps) {
  const navigate = useNavigate();
  const [recents, setRecents] = useState<RecentWorkspace[]>([]);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setRecents(getRecentWorkspaces());
    }
  }, [open]);

  const handleOpenRecent = useCallback(
    async (entry: RecentWorkspace) => {
      setPendingPath(entry.path);
      try {
        const landing = await prepareWorkspace(entry.path);
        navigate({ to: landing });
        onOpenChange(false);
      } catch (err) {
        console.error("[project-switcher] Failed to open recent project", err);
      } finally {
        setPendingPath(null);
      }
    },
    [navigate, onOpenChange],
  );

  const handleNewWorkspace = useCallback(() => {
    onOpenChange(false);
    setPickerOpen(true);
  }, [onOpenChange]);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align={align} side={side} className="w-72 text-xs">
          {recents.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No recent projects
            </div>
          ) : (
            recents.map((entry) => {
              const isPending = pendingPath === entry.path;
              const title =
                entry.projectName ?? folderLabelFromPath(entry.path);
              const fullPath = sanitizePath(entry.path);
              return (
                <DropdownMenuItem
                  key={`${entry.path}-${entry.lastOpenedAt}`}
                  onSelect={(event) => {
                    event.preventDefault();
                    if (!isPending) handleOpenRecent(entry);
                  }}
                  disabled={isPending}
                  className="flex items-start gap-2"
                >
                  {isPending ? (
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-foreground">{title}</span>
                    <span
                      className="truncate text-[10px] text-muted-foreground"
                      title={fullPath}
                    >
                      {fullPath}
                    </span>
                  </div>
                </DropdownMenuItem>
              );
            })
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              handleNewWorkspace();
            }}
            className="gap-2"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>New workspace</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorkspaceOpenDialog open={pickerOpen} onOpenChange={setPickerOpen} />
    </>
  );
}
