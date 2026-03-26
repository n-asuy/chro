import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deleteImage,
  uploadImage,
  uploadTaskImage,
  uploadTaskRunImage,
} from "@/lib/image-client";
import type { LocalImageMetadata } from "@/session/context/local-images-context";

export type ImageUploadStatus = "uploading" | "error" | "uploaded";

export type ImageUploadItem = {
  clientId: string;
  file: File;
  name: string;
  previewUrl: string;
  status: ImageUploadStatus;
  error?: string;
  imageId?: string;
  filePath?: string;
  mimeType?: string;
  sizeBytes?: number;
};

// Image markdown format: ![filename](path)
const imageToMarkdown = (name: string, path: string): string =>
  `![${name}](${path})`;
const normalizeFiles = (files: FileList | File[] | null): File[] => {
  if (!files) {
    return [];
  }
  return Array.isArray(files) ? files : Array.from(files);
};

type UploadTarget =
  | { type: "global" }
  | { type: "task"; taskId: string }
  | { type: "taskRun"; taskRunId: string };

interface UseImageUploadsOptions {
  getUploadTarget?: () => UploadTarget;
  addErrorMessage: (message: string) => void;
  formatUploadError: (file: File, error: unknown) => string;
}

export const useImageUploads = ({
  getUploadTarget,
  addErrorMessage,
  formatUploadError,
}: UseImageUploadsOptions) => {
  const [uploadItems, setUploadItems] = useState<ImageUploadItem[]>([]);
  const uploadItemsRef = useRef<ImageUploadItem[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadSequenceRef = useRef(0);

  const releasePreviewUrl = useCallback((url: string) => {
    if (
      typeof URL !== "undefined" &&
      typeof URL.revokeObjectURL === "function"
    ) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Ignore; Chromium might revoke automatically depending on scheme.
      }
    }
  }, []);

  useEffect(() => {
    uploadItemsRef.current = uploadItems;
  }, [uploadItems]);

  useEffect(() => {
    return () => {
      uploadItemsRef.current.forEach((item) =>
        releasePreviewUrl(item.previewUrl),
      );
    };
  }, [releasePreviewUrl]);

  const clearUploadItems = useCallback(() => {
    setUploadItems((prev) => {
      prev.forEach((item) => releasePreviewUrl(item.previewUrl));
      return [];
    });
    uploadSequenceRef.current = 0;
  }, [releasePreviewUrl]);

  const uploadSingleFile = useCallback(
    async (file: File, clientId: string) => {
      try {
        const target = getUploadTarget?.();
        const image =
          target?.type === "taskRun"
            ? await uploadTaskRunImage(target.taskRunId, file)
            : target?.type === "task"
              ? await uploadTaskImage(target.taskId, file)
              : await uploadImage(file);
        setUploadItems((prev) =>
          prev.map((item) =>
            item.clientId === clientId
              ? {
                  ...item,
                  status: "uploaded",
                  error: undefined,
                  imageId: image.id,
                  filePath: image.file_path,
                  mimeType: image.mime_type ?? undefined,
                  sizeBytes: image.size_bytes,
                }
              : item,
          ),
        );
      } catch (error) {
        const message = formatUploadError(file, error);
        addErrorMessage(message);
        setUploadItems((prev) =>
          prev.map((item) =>
            item.clientId === clientId
              ? { ...item, status: "error", error: message }
              : item,
          ),
        );
      }
    },
    [addErrorMessage, formatUploadError, getUploadTarget],
  );

  const handleFiles = useCallback(
    (files: FileList | File[] | null) => {
      const resolvedFiles = normalizeFiles(files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (resolvedFiles.length === 0) {
        return;
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      const nextItems = resolvedFiles.map((file) => {
        const clientId = `upload-${Date.now()}-${uploadSequenceRef.current++}`;
        return {
          clientId,
          file,
          name: file.name,
          previewUrl: URL.createObjectURL(file),
          status: "uploading" as ImageUploadStatus,
        } satisfies ImageUploadItem;
      });
      setUploadItems((prev) => [...prev, ...nextItems]);
      nextItems.forEach((item) => {
        void uploadSingleFile(item.file, item.clientId);
      });
    },
    [uploadSingleFile],
  );

  const handleRetryUpload = useCallback(
    (clientId: string) => {
      const target = uploadItems.find((item) => item.clientId === clientId);
      if (!target) {
        return;
      }
      setUploadItems((prev) =>
        prev.map((item) =>
          item.clientId === clientId
            ? { ...item, status: "uploading", error: undefined }
            : item,
        ),
      );
      void uploadSingleFile(target.file, clientId);
    },
    [uploadItems, uploadSingleFile],
  );

  const handleRemoveUpload = useCallback(
    (clientId: string) => {
      let previewUrl = "";
      let uploadedImageId: string | undefined;
      setUploadItems((prev) => {
        const target = prev.find((item) => item.clientId === clientId);
        if (target) {
          previewUrl = target.previewUrl;
          uploadedImageId = target.imageId;
        }
        return prev.filter((item) => item.clientId !== clientId);
      });
      if (previewUrl) {
        releasePreviewUrl(previewUrl);
      }
      if (uploadedImageId) {
        void deleteImage(uploadedImageId).catch((error) => {
          console.warn("Failed to delete uploaded image", error);
        });
      }
    },
    [releasePreviewUrl],
  );

  const handleSelectFiles = useCallback(() => {
    const input = fileInputRef.current;
    if (!input) {
      return;
    }
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
        // Fall back to click.
      }
    }
    input.click();
  }, []);

  const localImages: LocalImageMetadata[] = useMemo(
    () =>
      uploadItems
        .filter(
          (item): item is ImageUploadItem & { filePath: string; imageId: string } =>
            item.status === "uploaded" && !!item.filePath && !!item.imageId,
        )
        .map((item) => ({
          path: item.filePath,
          proxy_url: `/rpc/images/${item.imageId}/file`,
          file_name: item.name,
          size_bytes: item.sizeBytes ?? 0,
          format: item.mimeType?.split("/")[1] ?? "png",
        })),
    [uploadItems],
  );

  const getImageIds = useCallback(() => {
    const ids = uploadItems
      .filter((item) => item.status === "uploaded" && item.imageId)
      .map((item) => item.imageId as string);
    return ids.length > 0 ? ids : null;
  }, [uploadItems]);

  const getImagesMarkdown = useCallback(() => {
    const uploadedImages = uploadItems.filter(
      (item): item is ImageUploadItem & { filePath: string } =>
        item.status === "uploaded" && !!item.filePath,
    );
    if (uploadedImages.length === 0) return "";
    return uploadedImages
      .map((item) => imageToMarkdown(item.name, item.filePath))
      .join("\n");
  }, [uploadItems]);

  return {
    uploadItems,
    localImages,
    fileInputRef,
    handleFiles,
    handleSelectFiles,
    handleRetryUpload,
    handleRemoveUpload,
    clearUploadItems,
    getImageIds,
    getImagesMarkdown,
  };
};
