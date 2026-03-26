import { useEffect } from "react";

export const extractFilesFromDataTransfer = (
  dataTransfer?: DataTransfer | null,
): File[] => {
  if (!dataTransfer) {
    return [];
  }
  if (dataTransfer.files && dataTransfer.files.length > 0) {
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

const hasFiles = (event: DragEvent): boolean => {
  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) {
    return false;
  }
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return true;
  }
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    return Array.from(dataTransfer.items).some((item) => item.kind === "file");
  }
  const types = dataTransfer.types;
  return types ? Array.from(types).includes("Files") : false;
};

export const useGlobalFileDrop = (
  onFiles: (files: File[]) => void,
  enabled = true,
) => {
  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      return;
    }

    const handleDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
    };

    const handleDrop = (event: DragEvent) => {
      const files = extractFilesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      onFiles(files);
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, [enabled, onFiles]);
};
