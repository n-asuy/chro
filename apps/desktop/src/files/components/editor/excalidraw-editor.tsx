import { useLanguage } from "@/i18n";
import {
  getProjectBinaryFileUrl,
  getWorkspaceBinaryFileUrl,
  uploadProjectBinaryFile,
} from "@/lib/project-client";
import type {
  ExcalidrawInitialDataState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useProjectId } from "../../context/project-context";
import { useTextFileDocument } from "../../hooks/use-text-file-document";
import {
  type BinaryFileData,
  type BinaryFiles,
  type FileReference,
  type SceneAppState,
  type SceneElement,
  imagesToExternalize,
  parseScene,
  sceneSignature,
  serializeScene,
} from "../../lib/excalidraw-scene";

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

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((mod) => ({ default: mod.Excalidraw })),
);

/**
 * Edits arrive once per pointer move while drawing. Serializing on a short
 * trailing delay keeps that off the frame budget; the auto-save debounce runs
 * on top of it.
 */
const SERIALIZE_DELAY_MS = 300;

interface ExcalidrawEditorProps {
  /** Text document key (see `textFileKey`), shared with the file tab. */
  docKey: string;
  relativePath: string;
  initialContent: string;
  workspaceRootPath?: string;
  /** View the drawing without writing the file or its image sidecars. */
  readOnly: boolean;
}

type SceneChangeHandler = NonNullable<ExcalidrawProps["onChange"]>;

interface LatestScene {
  elements: readonly SceneElement[];
  appState: SceneAppState;
  files: BinaryFiles;
}

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
  docKey,
  relativePath,
  initialContent,
  workspaceRootPath,
  readOnly,
}: ExcalidrawEditorProps) => {
  const projectId = useProjectId();
  const { language } = useLanguage();
  const scene = useMemo(() => parseScene(initialContent), [initialContent]);

  const fileRefsRef = useRef(scene.fileRefs);
  const embeddedAtLoadRef = useRef<ReadonlySet<string>>(
    new Set(Object.keys(scene.files)),
  );
  const inFlightRef = useRef(new Set<string>());
  // The first callback reports the scene as loaded; it becomes the baseline.
  const lastSignatureRef = useRef<string | null>(null);
  const latestSceneRef = useRef<LatestScene | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSceneRef = useRef<() => void>(() => {});

  // Declared before the text document so this cleanup runs first on unmount
  // (React runs a component's effect cleanups in declaration order): the edit
  // still waiting to be serialized reaches the document before it closes and
  // writes.
  useEffect(
    () => () => {
      if (flushTimerRef.current) flushSceneRef.current();
      // An upload finishing after unmount must not schedule another flush.
      latestSceneRef.current = null;
    },
    [],
  );

  const { edit: editTextDocument, save: saveTextDocument } =
    useTextFileDocument({
      docKey,
      root: projectId ? { kind: "project", projectId } : null,
      relativePath,
      enabled: !readOnly,
    });

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
  const [initialData, setInitialData] =
    useState<ExcalidrawInitialDataState | null>(null);

  useEffect(() => {
    const loadInitialData = async () => {
      const loadedFiles = await loadFileRefsAsDataURLs(scene.fileRefs);

      const data = {
        elements: scene.elements,
        appState: {
          ...scene.appState,
          theme: "light",
        },
        // Merge loaded files with any existing base64 files
        files: { ...scene.files, ...loadedFiles },
        scrollToContent: true,
      };
      // The scene is parsed JSON in its on-disk shape; Excalidraw restores and
      // validates elements, app state and files when it reads initialData.
      setInitialData(data as unknown as ExcalidrawInitialDataState);
    };

    void loadInitialData();
  }, [scene, loadFileRefsAsDataURLs]);

  // Handle image file upload - saves to vault and returns file reference
  const uploadImageFile = useCallback(
    async (file: BinaryFileData): Promise<FileReference | null> => {
      if (!projectId) return null;

      try {
        // Convert dataURL to Blob
        const response = await fetch(file.dataURL);
        const blob = await response.blob();

        const imagePath = `${getImagesDir(relativePath)}/${generateImageFilename(file.mimeType)}`;
        await uploadProjectBinaryFile(projectId, imagePath, blob);

        return { path: imagePath, mimeType: file.mimeType };
      } catch (error) {
        console.error("[ExcalidrawEditor] Failed to upload image:", error);
        return null;
      }
    },
    [projectId, relativePath],
  );

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(
      () => flushSceneRef.current(),
      SERIALIZE_DELAY_MS,
    );
  }, []);

  const flushScene = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    const latest = latestSceneRef.current;
    if (!latest) return;

    editTextDocument(
      serializeScene({
        source: scene.source,
        elements: [...latest.elements],
        appState: latest.appState,
        files: latest.files,
        fileRefs: fileRefsRef.current,
      }),
    );

    const pending = imagesToExternalize({
      files: latest.files,
      fileRefs: fileRefsRef.current,
      embeddedAtLoad: embeddedAtLoadRef.current,
      inFlight: inFlightRef.current,
    });
    for (const fileId of pending) {
      inFlightRef.current.add(fileId);
      void uploadImageFile(latest.files[fileId]).then((ref) => {
        inFlightRef.current.delete(fileId);
        if (!ref) return;
        fileRefsRef.current = { ...fileRefsRef.current, [fileId]: ref };
        // Re-serialize so the inline base64 copy leaves the document.
        scheduleFlush();
      });
    }
  }, [scene.source, uploadImageFile, scheduleFlush, editTextDocument]);
  flushSceneRef.current = flushScene;

  const handleChange = useCallback<SceneChangeHandler>(
    (elements, appState, files) => {
      if (readOnly) return;
      const signature = sceneSignature(elements, appState, files);
      if (lastSignatureRef.current === null) {
        lastSignatureRef.current = signature;
        return;
      }
      if (signature === lastSignatureRef.current) return;
      lastSignatureRef.current = signature;
      latestSceneRef.current = { elements, appState, files };
      scheduleFlush();
    },
    [readOnly, scheduleFlush],
  );

  // Unload writes immediately, including an edit still waiting to be
  // serialized.
  const saveImmediately = useCallback(() => {
    if (readOnly) return;
    if (flushTimerRef.current) flushScene();
    void saveTextDocument();
  }, [readOnly, flushScene, saveTextDocument]);

  useEffect(() => {
    window.addEventListener("beforeunload", saveImmediately);
    return () => {
      window.removeEventListener("beforeunload", saveImmediately);
    };
  }, [saveImmediately]);

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
              initialData={initialData}
              onChange={handleChange}
              viewModeEnabled={readOnly}
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
