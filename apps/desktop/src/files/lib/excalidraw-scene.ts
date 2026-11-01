/**
 * The `.excalidraw` document model: what is persisted, when a change is worth
 * persisting, and which images move out of the JSON into sidecar files.
 *
 * Excalidraw reports every scene and view change (scroll, zoom, selection,
 * hover) through one callback. Anything done per callback runs per frame while
 * the user pans, so the editor gates all work on `sceneSignature`.
 */

export interface SceneElement {
  id: string;
  type: string;
  version: number;
  isDeleted: boolean;
  fileId?: string | null;
}

export interface SceneAppState {
  viewBackgroundColor?: string;
  gridSize?: number | null;
}

/** Excalidraw's in-memory image payload. */
export interface BinaryFileData {
  mimeType: string;
  id: string;
  dataURL: string;
  created: number;
  lastRetrieved?: number;
}

export type BinaryFiles = Record<string, BinaryFileData>;

/** An image stored as a sidecar file instead of inline base64. */
export interface FileReference {
  path: string;
  mimeType: string;
}

export type FileReferences = Record<string, FileReference>;

export interface SceneDocument {
  source: string;
  elements: SceneElement[];
  appState: SceneAppState;
  files: BinaryFiles;
  fileRefs: FileReferences;
}

const DEFAULT_SOURCE = "chro";

const persistedAppState = (appState: SceneAppState): SceneAppState => ({
  viewBackgroundColor: appState.viewBackgroundColor ?? "#ffffff",
  gridSize: appState.gridSize ?? null,
});

const emptyScene = (): SceneDocument => ({
  source: DEFAULT_SOURCE,
  elements: [],
  appState: persistedAppState({}),
  files: {},
  fileRefs: {},
});

export const parseScene = (content: string): SceneDocument => {
  if (!content.trim()) return emptyScene();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return emptyScene();
  }
  if (parsed?.type !== "excalidraw") return emptyScene();
  return {
    source: typeof parsed.source === "string" ? parsed.source : DEFAULT_SOURCE,
    elements: Array.isArray(parsed.elements)
      ? (parsed.elements as SceneElement[])
      : [],
    appState: persistedAppState((parsed.appState as SceneAppState) ?? {}),
    files: (parsed.files as BinaryFiles) ?? {},
    fileRefs: (parsed.fileRefs as FileReferences) ?? {},
  };
};

/**
 * Identity of everything `serializeScene` writes. Element versions increase
 * on every edit (the same measure Excalidraw uses for its own scene version),
 * so equal signatures mean the saved file would be byte-identical.
 */
export const sceneSignature = (
  elements: readonly SceneElement[],
  appState: SceneAppState,
  files: BinaryFiles,
): string => {
  let versionSum = 0;
  for (const el of elements) versionSum += el.version;
  const { viewBackgroundColor, gridSize } = persistedAppState(appState);
  return [
    elements.length,
    versionSum,
    viewBackgroundColor,
    gridSize,
    Object.keys(files).sort().join(","),
  ].join("|");
};

export const serializeScene = ({
  source,
  elements,
  appState,
  files,
  fileRefs,
}: SceneDocument): string => {
  const inlineFiles: BinaryFiles = {};
  for (const [id, file] of Object.entries(files)) {
    if (!fileRefs[id]) inlineFiles[id] = file;
  }
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source,
      elements: elements.filter((el) => !el.isDeleted),
      appState: persistedAppState(appState),
      files: inlineFiles,
      fileRefs,
    },
    null,
    2,
  );
};

/**
 * Images to move into sidecar files: only those added in this editing
 * session, each at most once. Images embedded by whoever authored the file
 * stay inline so opening a drawing never rewrites its storage format.
 */
export const imagesToExternalize = ({
  files,
  fileRefs,
  embeddedAtLoad,
  inFlight,
}: {
  files: BinaryFiles;
  fileRefs: FileReferences;
  embeddedAtLoad: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
}): string[] =>
  Object.keys(files).filter(
    (id) => !fileRefs[id] && !embeddedAtLoad.has(id) && !inFlight.has(id),
  );
