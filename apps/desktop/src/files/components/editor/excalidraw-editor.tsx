import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useAutoSave } from "../../hooks/use-auto-save";
import { useProjectId } from "../../context/project-context";
import { useLanguage } from "@/i18n";
import {
  getProjectBinaryFileUrl,
  getWorkspaceBinaryFileUrl,
  uploadProjectBinaryFile,
} from "@/lib/project-client";

// Excalidraw requires its CSS to be loaded
import "@excalidraw/excalidraw/index.css";

// Hide library button (not exposed via UIOptions)
const excalidrawStyles = `
  .sidebar-trigger__label-element,
  .default-sidebar-trigger,
  .sidebar-trigger {
    display: none !important;
  }
`;

// Excalidraw types
interface ExcalidrawElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted: boolean;
  fileId?: string;
  [key: string]: unknown;
}

interface AppState {
  viewBackgroundColor: string;
  gridSize: number | null;
  activeTool?: { type: string } | null;
  editingElement?: unknown;
  theme?: string;
  [key: string]: unknown;
}

// Excalidraw BinaryFileData format
interface BinaryFileData {
  mimeType: string;
  id: string;
  dataURL: string;
  created: number;
  lastRetrieved?: number;
}

type BinaryFiles = Record<string, BinaryFileData>;

// Custom file reference for Obsidian-style storage
interface FileReference {
  path: string;
  mimeType: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExcalidrawAPI = any;

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((mod) => ({ default: mod.Excalidraw })),
);

interface ExcalidrawEditorProps {
  relativePath: string;
  fileName: string;
  initialContent: string;
  workspaceRootPath?: string;
}

// Extended file data format with file references
interface ExcalidrawFileData {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState?: Partial<AppState>;
  files?: BinaryFiles;
  // Custom field: maps fileId to file path for Obsidian-style storage
  fileRefs?: Record<string, FileReference>;
}

const createEmptyExcalidrawData = (): ExcalidrawFileData => ({
  type: "excalidraw",
  version: 2,
  source: "chro",
  elements: [],
  appState: {
    viewBackgroundColor: "#ffffff",
    gridSize: null,
  },
  files: {},
  fileRefs: {},
});

const parseExcalidrawContent = (content: string): ExcalidrawFileData => {
  if (!content || content.trim() === "") {
    return createEmptyExcalidrawData();
  }

  try {
    const parsed = JSON.parse(content) as ExcalidrawFileData;
    if (parsed.type !== "excalidraw") {
      console.warn("[ExcalidrawEditor] Invalid file type, creating empty data");
      return createEmptyExcalidrawData();
    }
    return parsed;
  } catch (error) {
    console.warn("[ExcalidrawEditor] Failed to parse content:", error);
    return createEmptyExcalidrawData();
  }
};

// Serialize data - exclude base64 data for files that have refs
const serializeExcalidrawData = (
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
  fileRefs: Record<string, FileReference>,
): string => {
  // Only keep file data for files without refs (backward compatibility)
  const filteredFiles: BinaryFiles = {};
  for (const [id, file] of Object.entries(files)) {
    if (!fileRefs[id]) {
      filteredFiles[id] = file;
    }
  }

  const data: ExcalidrawFileData = {
    type: "excalidraw",
    version: 2,
    source: "chro",
    elements: elements.filter((el) => !el.isDeleted) as ExcalidrawElement[],
    appState: {
      viewBackgroundColor: appState.viewBackgroundColor,
      gridSize: appState.gridSize,
    },
    files: filteredFiles,
    fileRefs,
  };
  return JSON.stringify(data, null, 2);
};

// Get the images directory path for an excalidraw file
const getImagesDir = (excalidrawPath: string): string => {
  return `${excalidrawPath}.images`;
};

// Generate a unique filename for an image
const generateImageFilename = (mimeType: string): string => {
  const ext = mimeType.split("/")[1] || "png";
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `${timestamp}-${random}.${ext}`;
};

export const ExcalidrawEditor = ({
  relativePath,
  fileName,
  initialContent,
  workspaceRootPath,
}: ExcalidrawEditorProps) => {
  const projectId = useProjectId();
  const { language } = useLanguage();
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawAPI>(null);
  const [content, setContent] = useState(initialContent);
  const contentRef = useRef(content);
  const isInitialLoadRef = useRef(true);

  // Track file references (fileId -> path)
  const [fileRefs, setFileRefs] = useState<Record<string, FileReference>>(
    () => {
      const parsed = parseExcalidrawContent(initialContent);
      return parsed.fileRefs ?? {};
    },
  );
  const fileRefsRef = useRef(fileRefs);
  fileRefsRef.current = fileRefs;

  // Keep content ref in sync
  contentRef.current = content;

  // Load file references and convert to BinaryFileData for Excalidraw
  const loadFileRefsAsDataURLs = useCallback(
    async (refs: Record<string, FileReference>): Promise<BinaryFiles> => {
      if (!projectId && !workspaceRootPath) return {};

      const files: BinaryFiles = {};
      for (const [fileId, ref] of Object.entries(refs)) {
        try {
          const url = workspaceRootPath
            ? getWorkspaceBinaryFileUrl(workspaceRootPath, ref.path)
            : getProjectBinaryFileUrl(projectId!, ref.path);
          const response = await fetch(url);
          if (!response.ok) continue;

          const blob = await response.blob();
          const dataURL = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });

          files[fileId] = {
            id: fileId,
            mimeType: ref.mimeType,
            dataURL,
            created: Date.now(),
          };
        } catch (error) {
          console.warn(
            `[ExcalidrawEditor] Failed to load file ref: ${ref.path}`,
            error,
          );
        }
      }
      return files;
    },
    [projectId, workspaceRootPath],
  );

  // Initial data with loaded file references
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [initialData, setInitialData] = useState<any>(null);

  useEffect(() => {
    const loadInitialData = async () => {
      const parsed = parseExcalidrawContent(initialContent);
      const loadedFiles = await loadFileRefsAsDataURLs(parsed.fileRefs ?? {});

      // Merge loaded files with any existing base64 files
      const mergedFiles = { ...parsed.files, ...loadedFiles };

      setInitialData({
        elements: parsed.elements,
        appState: {
          ...parsed.appState,
          theme: "light",
        },
        files: mergedFiles,
        scrollToContent: true,
      });
    };

    void loadInitialData();
  }, [initialContent, loadFileRefsAsDataURLs]);

  // Auto-save
  const { saveNow, isDirty } = useAutoSave({
    relativePath,
    content,
    enabled: !workspaceRootPath,
    debounceMs: 2000,
  });

  // Save on blur
  useEffect(() => {
    const handleBlur = () => {
      if (isDirty) {
        void saveNow();
      }
    };

    window.addEventListener("blur", handleBlur);
    return () => window.removeEventListener("blur", handleBlur);
  }, [isDirty, saveNow]);

  // Save before window close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isDirty) {
        void saveNow();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty, saveNow]);

  // Handle image file upload - saves to vault and returns file reference
  const uploadImageFile = useCallback(
    async (
      fileId: string,
      dataURL: string,
      mimeType: string,
    ): Promise<FileReference | null> => {
      if (!projectId || workspaceRootPath) return null;

      try {
        // Convert dataURL to Blob
        const response = await fetch(dataURL);
        const blob = await response.blob();

        // Generate path
        const imagesDir = getImagesDir(relativePath);
        const filename = generateImageFilename(mimeType);
        const imagePath = `${imagesDir}/${filename}`;

        // Upload to vault
        await uploadProjectBinaryFile(projectId, imagePath, blob);

        return { path: imagePath, mimeType };
      } catch (error) {
        console.error("[ExcalidrawEditor] Failed to upload image:", error);
        return null;
      }
    },
    [projectId, relativePath, workspaceRootPath],
  );

  // Handle onChange - detect new images and upload them
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleChange = useCallback(
    (elements: readonly any[], appState: any, files: any) => {
      // Skip the initial onChange call
      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false;
        return;
      }

      // Serialize and save immediately (sync part)
      const currentRefs = { ...fileRefsRef.current };
      const serialized = serializeExcalidrawData(
        elements,
        appState,
        files,
        currentRefs,
      );
      setContent(serialized);

      // Upload new images asynchronously (don't block onChange)
      const uploadNewImages = async () => {
        let refsUpdated = false;
        const updatedRefs = { ...currentRefs };

        for (const [fileId, file] of Object.entries(files) as [
          string,
          BinaryFileData,
        ][]) {
          // Skip if already has a ref
          if (updatedRefs[fileId]) continue;

          // Upload new image
          const ref = await uploadImageFile(
            fileId,
            file.dataURL,
            file.mimeType,
          );
          if (ref) {
            updatedRefs[fileId] = ref;
            refsUpdated = true;
          }
        }

        if (refsUpdated) {
          setFileRefs(updatedRefs);
          // Re-serialize with updated refs to remove base64 data
          const updated = serializeExcalidrawData(
            elements,
            appState,
            files,
            updatedRefs,
          );
          setContent(updated);
        }
      };

      void uploadNewImages();
    },
    [uploadImageFile],
  );

  const elementCount = excalidrawAPI
    ? excalidrawAPI
        .getSceneElements()
        .filter((el: ExcalidrawElement) => !el.isDeleted).length
    : 0;

  // Show loading until initial data is ready
  if (!initialData) {
    return (
      <div className="flex h-full w-full flex-1 flex-col bg-white font-workspace">
        <div className="flex h-full w-full items-center justify-center text-sm text-[#6d6f78]">
          Loading Excalidraw...
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-white font-workspace">
      <style>{excalidrawStyles}</style>
      <div className="relative flex-1 overflow-hidden" style={{ minHeight: 0 }}>
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center text-sm text-[#6d6f78]">
              Loading Excalidraw...
            </div>
          }
        >
          <div style={{ width: "100%", height: "100%" }}>
            <Excalidraw
              excalidrawAPI={setExcalidrawAPI}
              initialData={initialData}
              onChange={handleChange}
              langCode={language === "ja" ? "ja-JP" : "en"}
              UIOptions={{
                canvasActions: {
                  loadScene: false,
                  export: false,
                  saveAsImage: true,
                },
              }}
            />
          </div>
        </Suspense>
      </div>
    </div>
  );
};
