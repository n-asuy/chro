import { useLanguage } from "@/i18n";
import { Button } from "@chro/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chro/ui/dialog";
import { Input } from "@chro/ui/input";
import { cn } from "@chro/ui/utils";
import { Folder, FolderRoot, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FileNode } from "../../types/file-tree";
import { FileNodeType } from "../../types/file-tree";

interface MoveSelectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileTree: FileNode[];
  rootPath: string;
  selectedPaths: string[];
  onMove: (targetParentPath: string) => Promise<void>;
}

interface FolderDestination {
  path: string;
  label: string;
  depth: number;
}

export function MoveSelectionDialog({
  open,
  onOpenChange,
  fileTree,
  rootPath,
  selectedPaths,
  onMove,
}: MoveSelectionDialogProps) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [targetPath, setTargetPath] = useState(rootPath);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState("");

  const destinations = useMemo(() => {
    const result: FolderDestination[] = [
      { path: rootPath, label: t("moveItemsProjectRoot"), depth: 0 },
    ];
    const walk = (nodes: FileNode[], depth: number) => {
      for (const node of nodes) {
        if (node.type !== FileNodeType.Directory) continue;
        const invalid = selectedPaths.some(
          (selectedPath) =>
            node.path === selectedPath ||
            node.path.startsWith(`${selectedPath}/`),
        );
        if (!invalid) {
          result.push({ path: node.path, label: node.name, depth });
        }
        if (node.children?.length) {
          walk(node.children, depth + 1);
        }
      }
    };
    walk(fileTree, 1);
    return result;
  }, [fileTree, rootPath, selectedPaths, t]);

  const filteredDestinations = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return destinations;
    return destinations.filter(
      (destination) =>
        destination.label.toLocaleLowerCase().includes(normalized) ||
        destination.path.toLocaleLowerCase().includes(normalized),
    );
  }, [destinations, query]);
  const effectiveTargetPath = filteredDestinations.some(
    (destination) => destination.path === targetPath,
  )
    ? targetPath
    : filteredDestinations[0]?.path ?? "";

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTargetPath(rootPath);
    setError("");
  }, [open, rootPath]);

  const handleMove = async (destination = effectiveTargetPath) => {
    if (!destination || moving) return;
    setMoving(true);
    setError("");
    try {
      await onMove(destination);
      onOpenChange(false);
    } catch (moveError) {
      setError(
        moveError instanceof Error
          ? moveError.message
          : t("moveItemsGenericError"),
      );
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[560px] w-full max-w-[480px] flex-col overflow-hidden border-custom-border-200 bg-custom-background-100 text-foreground">
        <DialogHeader>
          <DialogTitle>
            {t("moveItemsDialogTitle", { count: selectedPaths.length })}
          </DialogTitle>
          <DialogDescription>
            {t("moveItemsDialogDescription")}
          </DialogDescription>
        </DialogHeader>

        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && filteredDestinations.length === 1) {
              event.preventDefault();
              void handleMove(filteredDestinations[0]?.path);
            }
          }}
          placeholder={t("moveItemsSearchPlaceholder")}
        />

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-custom-border-200 bg-custom-background-90 p-1">
          {filteredDestinations.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-custom-text-300">
              {t("moveItemsNoFolders")}
            </div>
          ) : (
            filteredDestinations.map((destination) => {
              const selected = destination.path === effectiveTargetPath;
              return (
                <button
                  key={destination.path}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-custom-text-200 hover:bg-custom-background-80",
                    selected && "bg-primary/10 text-custom-text-100",
                  )}
                  style={{ paddingLeft: `${8 + destination.depth * 14}px` }}
                  onClick={() => setTargetPath(destination.path)}
                  onDoubleClick={() => void handleMove(destination.path)}
                >
                  {destination.depth === 0 ? (
                    <FolderRoot className="size-4 shrink-0" />
                  ) : (
                    <Folder className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {destination.label}
                  </span>
                  {destination.depth > 0 && (
                    <span className="max-w-[45%] truncate text-xs text-custom-text-400">
                      {destination.path}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={moving}
          >
            {t("cancelButtonLabel")}
          </Button>
          <Button
            type="button"
            onClick={() => void handleMove()}
            disabled={!effectiveTargetPath || moving}
          >
            {moving && <Loader2 className="mr-2 size-4 animate-spin" />}
            {t("moveItemsAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
