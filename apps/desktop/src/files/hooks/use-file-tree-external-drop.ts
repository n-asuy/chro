import { useCallback, useEffect, useRef, useState } from "react";

interface DropTarget {
  path: string;
  isDir: boolean;
}

interface ExternalDropState {
  isDraggingOver: boolean;
  dropTarget: DropTarget | null;
}

const initialState: ExternalDropState = {
  isDraggingOver: false,
  dropTarget: null,
};

interface UseFileTreeExternalDropOptions {
  rootPath: string | null;
  enabled?: boolean;
  onDrop: (files: File[], targetPath: string) => Promise<void>;
}

interface UseFileTreeExternalDropReturn {
  dropState: ExternalDropState;
}

const hasFiles = (event: DragEvent): boolean => {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return false;
  if (dataTransfer.files?.length > 0) return true;
  if (dataTransfer.items?.length > 0) {
    return Array.from(dataTransfer.items).some((item) => item.kind === "file");
  }
  const types = dataTransfer.types;
  return types ? Array.from(types).includes("Files") : false;
};

const extractFiles = (dataTransfer?: DataTransfer | null): File[] => {
  if (!dataTransfer) return [];
  if (dataTransfer.files?.length > 0) {
    return Array.from(dataTransfer.files);
  }
  if (!dataTransfer.items || dataTransfer.items.length === 0) {
    return [];
  }
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
};

const getDropTargetFromElement = (
  element: Element | null,
  rootPath: string | null,
): DropTarget | null => {
  if (!element) return null;

  const fileTreeItem = element.closest("[data-file-path]");
  if (fileTreeItem) {
    const path = fileTreeItem.getAttribute("data-file-path");
    const isDir = fileTreeItem.getAttribute("data-is-dir") === "true";
    if (path) {
      // If dropped on a file, use its parent directory
      if (!isDir) {
        const pathParts = path.split("/");
        pathParts.pop();
        const parentPath = pathParts.join("/") || rootPath || "/";
        return { path: parentPath, isDir: true };
      }
      return { path, isDir };
    }
  }

  const fileTreeContainer = element.closest("[data-file-tree-root]");
  if (fileTreeContainer) {
    return { path: rootPath || "/", isDir: true };
  }

  return null;
};

export function useFileTreeExternalDrop({
  rootPath,
  enabled = true,
  onDrop,
}: UseFileTreeExternalDropOptions): UseFileTreeExternalDropReturn {
  const [dropState, setDropState] = useState<ExternalDropState>(initialState);
  const dragCounterRef = useRef(0);

  const handleDragEnter = useCallback(
    (event: DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();

      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) {
        setDropState((prev) => ({ ...prev, isDraggingOver: true }));
      }
    },
    [enabled],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopPropagation();

      dragCounterRef.current -= 1;
      if (dragCounterRef.current === 0) {
        setDropState(initialState);
      }
    },
    [enabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();

      // Update drop target based on mouse position
      const element = document.elementFromPoint(event.clientX, event.clientY);
      const dropTarget = getDropTargetFromElement(element, rootPath);

      setDropState((prev) => ({
        ...prev,
        isDraggingOver: true,
        dropTarget,
      }));
    },
    [enabled, rootPath],
  );

  const handleDrop = useCallback(
    async (event: DragEvent) => {
      if (!enabled || !hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();

      dragCounterRef.current = 0;

      const files = extractFiles(event.dataTransfer);
      if (files.length === 0) {
        setDropState(initialState);
        return;
      }

      const element = document.elementFromPoint(event.clientX, event.clientY);
      const dropTarget = getDropTargetFromElement(element, rootPath);
      const targetPath = dropTarget?.path || rootPath || "/";

      try {
        await onDrop(files, targetPath);
      } catch (error) {
        console.error("[use-file-tree-external-drop] Drop failed:", error);
      } finally {
        setDropState(initialState);
      }
    },
    [enabled, rootPath, onDrop],
  );

  useEffect(() => {
    if (!enabled) return;

    const container = document.querySelector("[data-file-tree-root]");
    if (!container) return;

    container.addEventListener("dragenter", handleDragEnter as EventListener);
    container.addEventListener("dragleave", handleDragLeave as EventListener);
    container.addEventListener("dragover", handleDragOver as EventListener);
    container.addEventListener("drop", handleDrop as EventListener);

    return () => {
      container.removeEventListener(
        "dragenter",
        handleDragEnter as EventListener,
      );
      container.removeEventListener(
        "dragleave",
        handleDragLeave as EventListener,
      );
      container.removeEventListener(
        "dragover",
        handleDragOver as EventListener,
      );
      container.removeEventListener("drop", handleDrop as EventListener);
    };
  }, [enabled, handleDragEnter, handleDragLeave, handleDragOver, handleDrop]);

  return { dropState };
}
