
import { useCallback, useEffect, useState } from "react";
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
import {
  filesystemApi,
  type DirectoryEntry,
  type DirectoryListResponse,
} from "@/lib/filesystem-client";

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
      <DialogContent className="max-w-[600px] w-full h-[600px] flex flex-col overflow-hidden bg-[#181818] border-white/10 text-white">
        <DialogHeader>
          <DialogTitle className="text-white">{title}</DialogTitle>
          <DialogDescription className="text-white/60">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex flex-col space-y-4 overflow-hidden">
          {/* Navigation */}
          <div className="flex items-center space-x-2 min-w-0">
            <Button
              onClick={handleHomeDirectory}
              variant="outline"
              size="sm"
              className="flex-shrink-0 border-white/10 text-white hover:bg-white/5"
              title="Home directory"
            >
              <Home className="h-4 w-4" />
            </Button>
            <Button
              onClick={handleParentDirectory}
              variant="outline"
              size="sm"
              disabled={!currentPath || currentPath === "/"}
              className="flex-shrink-0 border-white/10 text-white hover:bg-white/5 disabled:opacity-50"
              title="Parent directory"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <div className="text-sm text-white/60 flex-1 truncate min-w-0">
              {currentPath || "Home"}
            </div>
            {currentIsGitRepo && (
              <span className="text-xs text-white/40 flex-shrink-0">Git</span>
            )}
          </div>

          {/* Directory listing */}
          <div className="flex-1 border border-white/10 rounded-md overflow-auto bg-white/5">
            {loading ? (
              <div className="p-4 text-center text-white/50 flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading...
              </div>
            ) : error ? (
              <div className="m-4 p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span className="text-sm">{error}</span>
              </div>
            ) : entries.length === 0 ? (
              <div className="p-4 text-center text-white/50">
                Empty directory
              </div>
            ) : (
              <div className="p-2">
                {entries.map((entry, index) => (
                  <div
                    key={`${entry.path}-${index}`}
                    className={`flex items-center space-x-2 p-2 rounded cursor-pointer hover:bg-white/10 ${
                      !entry.is_directory ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    onClick={() =>
                      entry.is_directory && handleFolderClick(entry)
                    }
                    title={entry.path}
                  >
                    {entry.is_directory ? (
                      <Folder className="h-4 w-4 text-white/70 flex-shrink-0" />
                    ) : (
                      <File className="h-4 w-4 text-white/40 flex-shrink-0" />
                    )}
                    <span className="text-sm flex-1 truncate min-w-0 text-white/90">
                      {entry.name}
                    </span>
                    {entry.is_git_repo && (
                      <span className="text-xs text-white/40 flex-shrink-0">
                        Git
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
            className="border-white/10 text-white hover:bg-white/5"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSelectCurrent}
            disabled={!currentPath}
            className="bg-white text-black hover:bg-white/90 disabled:opacity-50"
          >
            Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
