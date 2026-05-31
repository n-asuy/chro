import {
  type DirectoryEntry,
  type DirectoryListResponse,
  filesystemApi,
} from "@/lib/filesystem-client";
import { Button } from "@chro/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chro/ui/dialog";
import {
  AlertCircle,
  ChevronUp,
  File,
  Folder,
  Home,
  Loader2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function EntryRowContent({ entry }: { entry: DirectoryEntry }) {
  return (
    <>
      {entry.is_directory ? (
        <Folder className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
      ) : (
        <File className="h-4 w-4 flex-shrink-0 text-muted-foreground/60" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {entry.name}
      </span>
      {entry.is_git_repo && (
        <span className="flex-shrink-0 rounded bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">
          Git
        </span>
      )}
    </>
  );
}

interface FolderPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string | null) => void;
  initialPath?: string;
  title?: string;
  description?: string;
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  onSelect,
  initialPath = "",
  title = "Select Folder",
  description = "Choose a folder for your workspace",
}: FolderPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [currentIsGitRepo, setCurrentIsGitRepo] = useState(false);
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadDirectory = useCallback(async (path?: string) => {
    setLoading(true);
    setError("");

    try {
      const result: DirectoryListResponse =
        await filesystemApi.listDirectory(path);

      if (!result || typeof result !== "object") {
        throw new Error("Invalid response from filesystem API");
      }
      const entries = Array.isArray(result.entries) ? result.entries : [];
      setEntries(entries);
      const newPath = result.current_path || "";
      setCurrentPath(newPath);
      setCurrentIsGitRepo(result.is_git_repo ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadDirectory(initialPath || undefined);
    }
  }, [open, initialPath, loadDirectory]);

  const handleFolderClick = (entry: DirectoryEntry) => {
    if (entry.is_directory) {
      loadDirectory(entry.path);
    }
  };

  const handleParentDirectory = () => {
    const parentPath = currentPath.split("/").slice(0, -1).join("/");
    const newPath = parentPath || "/";
    loadDirectory(newPath);
  };

  const handleHomeDirectory = () => {
    loadDirectory();
  };

  const handleSelectCurrent = () => {
    onSelect(currentPath);
    onOpenChange(false);
  };

  const handleCancel = () => {
    onSelect(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[600px] w-full max-w-[600px] flex-col overflow-hidden border-custom-border-200 bg-custom-background-100 text-foreground">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 flex-col space-y-4 overflow-hidden">
          {/* Navigation */}
          <div className="flex min-w-0 items-center space-x-2">
            <Button
              onClick={handleHomeDirectory}
              variant="outline"
              size="sm"
              className="flex-shrink-0"
              title="Home directory"
            >
              <Home className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleParentDirectory}
              variant="outline"
              size="sm"
              disabled={!currentPath || currentPath === "/"}
              className="flex-shrink-0"
              title="Parent directory"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <div className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {currentPath || "Home"}
            </div>
            {currentIsGitRepo && (
              <span className="flex-shrink-0 rounded bg-accent px-1.5 py-0.5 text-xs text-muted-foreground">
                Git
              </span>
            )}
          </div>

          {/* Directory listing */}
          <div className="flex-1 overflow-auto rounded-md border border-custom-border-200 bg-custom-background-90">
            {loading ? (
              <div className="flex items-center justify-center gap-2 p-4 text-center text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : error ? (
              <div className="m-4 flex items-start gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span className="text-sm">{error}</span>
              </div>
            ) : entries.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground">
                Empty directory
              </div>
            ) : (
              <div className="p-2">
                {entries.map((entry, index) =>
                  entry.is_directory ? (
                    <button
                      type="button"
                      key={`${entry.path}-${index}`}
                      className="flex w-full cursor-pointer items-center space-x-2 rounded p-2 text-left hover:bg-accent"
                      onClick={() => handleFolderClick(entry)}
                      title={entry.path}
                    >
                      <EntryRowContent entry={entry} />
                    </button>
                  ) : (
                    <div
                      key={`${entry.path}-${index}`}
                      className="flex cursor-not-allowed items-center space-x-2 rounded p-2 opacity-50"
                      title={entry.path}
                    >
                      <EntryRowContent entry={entry} />
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button type="button" variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleSelectCurrent} disabled={!currentPath}>
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
