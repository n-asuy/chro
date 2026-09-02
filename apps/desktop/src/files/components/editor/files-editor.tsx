import {
  isImageExtension as isImageFile,
  isPdfExtension as isPdfFile,
  isVideoExtension as isVideoFile,
} from "@/files/media-types";
import { openExternalUrl } from "@/lib/open-external-url";
import {
  getProjectAssetUrl,
  getProjectBinaryFileUrl,
  getTaskRunAssetUrl,
  getTaskRunBinaryFileUrl,
  getWorkspaceAssetUrl,
  getWorkspaceBinaryFileUrl,
  readProjectFile,
  readTaskRunFile,
  readWorkspaceFileAtPath,
  resolveProjectFile,
} from "@/lib/project-client";
import type { DesktopWorkspaceFile } from "@/types/desktop";
import { Button } from "@chro/ui/button";
import { cn } from "@chro/ui/utils";
import { Code, Eye, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import {
  type ChangeEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import TextareaAutosize from "react-textarea-autosize";
import { BaseViewer } from "../../../cbase/components/cbase-viewer";
import { useProjectId } from "../../context/project-context";
import { useAutoSave } from "../../hooks/use-auto-save";
import { delimiterForExtension } from "../../lib/csv";
import {
  type HtmlViewMode,
  isLargeTextSafeMode,
  resolveCodeViewState,
} from "../../lib/editor-safe-mode";
import { resolveEmbedPath } from "../../lib/embed-path";
import { fileNamesEqual } from "../../lib/file-name-key";
import {
  type Frontmatter,
  combineFrontmatterAndBody,
  parseFrontmatter,
} from "../../lib/frontmatter";
import {
  PREVIEW_LINK_BRIDGE_PARAM,
  parsePreviewLinkMessage,
  resolvePreviewLinkTarget,
} from "../../lib/preview-link";
import { useFileTreeStore } from "../../state/file-tree-store";
import { type WorkspaceRoot, useFilesStore } from "../../state/files-store";
import type { FileNode } from "../../types/file-tree";
import { CodeMirrorEditor, type CodeMirrorEditorHandle } from "./codemirror";
import { FormattingMenu } from "./codemirror/plugins/bubble-menu";
import type { EmbedPluginConfig } from "./codemirror/plugins/prose";
import { CsvEditor } from "./csv-editor";
import { EditorFindBar } from "./editor-find-bar";
import { ExcalidrawEditor } from "./excalidraw-editor";
import {
  FrontmatterEditor,
  type FrontmatterViewMode,
} from "./frontmatter-editor";
import { ImageViewer } from "./image-viewer";
import { PdfViewer } from "./pdf-viewer";
import { VideoViewer } from "./video-viewer";

const EXCALIDRAW_EXTENSIONS = new Set(["excalidraw"]);

const BASE_EXTENSIONS = new Set(["cbase"]);

const HTML_EXTENSIONS = new Set(["html", "htm"]);

const CSV_EXTENSIONS = new Set(["csv", "tsv"]);

/** Extensions rendered as prose (WYSIWYG markdown editor) */
const PROSE_EXTENSIONS = new Set(["md", "mdx", "txt"]);

const setIframeKeydownListener = (
  frameWindow: Window | null,
  listener: (event: globalThis.KeyboardEvent) => void,
  enabled: boolean,
): void => {
  if (!frameWindow) return;
  try {
    if (enabled) {
      frameWindow.addEventListener("keydown", listener, true);
    } else {
      frameWindow.removeEventListener("keydown", listener, true);
    }
  } catch {
    // The preview may navigate cross-origin; the parent-window listener still
    // handles Escape whenever focus returns to the app.
  }
};

const formatFileSize = (bytes?: number | null): string => {
  if (!bytes || bytes < 1024) return `${bytes ?? 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

const isProseFile = (extension?: string | null): boolean => {
  // Prose view is a strict whitelist. Extensionless files (LICENSE, Makefile)
  // and dotfiles (.env, .gitignore) fall through to the code editor.
  if (!extension) return false;
  return PROSE_EXTENSIONS.has(extension.toLowerCase());
};

const isExcalidrawFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return EXCALIDRAW_EXTENSIONS.has(extension.toLowerCase());
};

const isBaseFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return BASE_EXTENSIONS.has(extension.toLowerCase());
};

const isHtmlFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return HTML_EXTENSIONS.has(extension.toLowerCase());
};

const isCsvFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return CSV_EXTENSIONS.has(extension.toLowerCase());
};

const findNodeByPath = (
  nodes: FileNode[],
  target: string | null,
): FileNode | null => {
  if (!target) return null;
  const walk = (list: FileNode[]): FileNode | null => {
    for (const node of list) {
      if (node.path === target) return node;
      if (node.children?.length) {
        const child = walk(node.children);
        if (child) return child;
      }
    }
    return null;
  };
  return walk(nodes);
};

const findWorkspaceRootForPath = (
  roots: WorkspaceRoot[],
  target: string | null,
): WorkspaceRoot | null => {
  if (!target) return null;
  let best: WorkspaceRoot | null = null;
  for (const root of roots) {
    if (root.isPrimary) continue;
    if (target === root.path || target.startsWith(`${root.path}/`)) {
      if (!best || root.path.length > best.path.length) best = root;
    }
  }
  return best;
};

const relativePathForFile = (
  filePath: string | null,
  node: FileNode | null,
  workspaceRoot: WorkspaceRoot | null,
): string | null => {
  if (!filePath) return null;
  if (node?.relativePath) return node.relativePath;
  if (workspaceRoot) {
    if (filePath === workspaceRoot.path) return "";
    if (filePath.startsWith(`${workspaceRoot.path}/`)) {
      return filePath.slice(workspaceRoot.path.length + 1);
    }
  }
  // Virtual tree paths (e.g. "/docs/x.md") and host-absolute paths emitted by
  // agents (e.g. "/Users/.../proj/docs/x.md") are both forwarded as-is. The
  // server's path resolver (see crates/server/.../path_resolve.rs) strips any
  // matching candidate root before reading from disk. Leaving the leading
  // slash in place is what triggers that resolution.
  return filePath;
};

type FilesEditorProps = {
  path?: string;
  /**
   * If set, file content is read from this task run's worktree
   * (container_ref / workspace_path) instead of the project main checkout.
   * Editing/saving falls back to project paths and is disabled until a
   * worktree write endpoint exists; for now treat task-run files as read-only.
   */
  taskRunId?: string;
  /** Close the transient file tab after Escape leaves fullscreen preview. */
  onHtmlFullscreenEscape?: () => void;
};

export const FilesEditor = ({
  path,
  taskRunId,
  onHtmlFullscreenEscape,
}: FilesEditorProps) => {
  const projectId = useProjectId();
  const {
    currentFilePath,
    fileTree,
    roots,
    renameDisplayName,
    openFile,
    openFilePath,
    selectNode,
    fileContentVersion,
    editorReveal,
  } = useFilesStore();
  const { expandToPath } = useFileTreeStore();
  const editorFilePath = path ?? currentFilePath;
  const editorRef = useRef<CodeMirrorEditorHandle>(null);
  const workspaceRoot = useMemo(
    () => findWorkspaceRootForPath(roots, editorFilePath),
    [roots, editorFilePath],
  );
  const currentNode = useMemo(
    () =>
      workspaceRoot
        ? findNodeByPath(workspaceRoot.children ?? [], editorFilePath)
        : findNodeByPath(fileTree, editorFilePath),
    [fileTree, workspaceRoot, editorFilePath],
  );

  const fallbackFileName = useMemo(() => {
    const cleaned = (editorFilePath ?? "").replace(/^\/+/, "");
    return cleaned.split("/").pop() ?? "";
  }, [editorFilePath]);

  const fallbackDisplayName = useMemo(() => {
    if (!fallbackFileName) return "";
    return fallbackFileName.endsWith(".md")
      ? fallbackFileName.slice(0, -3)
      : fallbackFileName;
  }, [fallbackFileName]);

  const fallbackExtension = useMemo(() => {
    if (!fallbackFileName) return null;
    const lastDot = fallbackFileName.lastIndexOf(".");
    if (lastDot <= 0 || lastDot === fallbackFileName.length - 1) return null;
    return fallbackFileName.slice(lastDot + 1);
  }, [fallbackFileName]);

  const [content, setContent] = useState<string>("");
  // Track which file path the current content belongs to
  const [loadedFilePath, setLoadedFilePath] = useState<string | null>(null);
  const [workspaceFile, setWorkspaceFile] =
    useState<DesktopWorkspaceFile | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleError, setTitleError] = useState<string | null>(null);
  const [isRenamingTitle, setIsRenamingTitle] = useState(false);

  // Scroll the editor to a requested line (e.g. a full-text search hit) once the
  // matching file's content has loaded. Handled-token tracking prevents
  // re-scrolling as unrelated state (content reloads) settles.
  const handledRevealTokenRef = useRef(0);
  useEffect(() => {
    if (!editorReveal) return;
    if (editorReveal.token === handledRevealTokenRef.current) return;
    const target = editorFilePath;
    if (!target) return;
    const stripSlash = (p: string) => p.replace(/^\/+/, "");
    if (stripSlash(editorReveal.path) !== stripSlash(target)) return;
    // Wait until the loaded content belongs to this file, so CodeMirror has the
    // document to scroll within.
    if (!loadedFilePath || stripSlash(loadedFilePath) !== stripSlash(target)) {
      return;
    }
    handledRevealTokenRef.current = editorReveal.token;
    const line = editorReveal.line;
    // Defer one frame so the CodeMirror view has rebuilt for freshly loaded
    // content before we scroll it.
    const raf = requestAnimationFrame(() => {
      editorRef.current?.scrollToLine(line);
    });
    return () => cancelAnimationFrame(raf);
  }, [editorReveal, editorFilePath, loadedFilePath]);

  // Frontmatter state - parsed from content
  const [frontmatter, setFrontmatter] = useState<Frontmatter>({});
  const [editorBody, setEditorBody] = useState<string>("");
  const [frontmatterViewMode, setFrontmatterViewMode] =
    useState<FrontmatterViewMode>("ui");

  // HTML viewer toggle: "preview" renders an iframe, "raw" shows source in CodeMirror
  const [htmlViewMode, setHtmlViewMode] = useState<HtmlViewMode>("preview");
  // Bumped manually to force the preview iframe to reload after a save / refresh
  const [htmlPreviewKey, setHtmlPreviewKey] = useState(0);
  // Expands the HTML preview to fill the entire app window. Exits on Escape,
  // when switching to raw source, or when the active file changes.
  const [isHtmlFullscreen, setIsHtmlFullscreen] = useState(false);
  const htmlPreviewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const isHtmlFullscreenRef = useRef(isHtmlFullscreen);
  const onHtmlFullscreenEscapeRef = useRef(onHtmlFullscreenEscape);
  isHtmlFullscreenRef.current = isHtmlFullscreen;
  onHtmlFullscreenEscapeRef.current = onHtmlFullscreenEscape;

  // In-editor find bar (Cmd/Ctrl+F). Rendered above the title/frontmatter so
  // it floats at the top of the file view like Obsidian's find panel.
  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const openFindBar = useCallback(() => setIsFindOpen(true), []);
  const closeFindBar = useCallback(() => {
    setIsFindOpen(false);
    editorRef.current?.focus();
  }, []);
  // Reset transient view state whenever the active file changes.
  useEffect(() => {
    setIsFindOpen(false);
    setIsHtmlFullscreen(false);
  }, [editorFilePath]);

  const handleHtmlPreviewKeyDown = useCallback(
    (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !isHtmlFullscreenRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      setIsHtmlFullscreen(false);
      onHtmlFullscreenEscapeRef.current?.();
    },
    [],
  );

  const handleHtmlPreviewLoad = useCallback(
    (event: SyntheticEvent<HTMLIFrameElement>) => {
      // Keyboard events do not bubble out of an iframe. Register on its Window
      // as well so Escape works after the user interacts with the preview.
      const frameWindow = event.currentTarget.contentWindow;
      setIframeKeydownListener(frameWindow, handleHtmlPreviewKeyDown, false);
      setIframeKeydownListener(frameWindow, handleHtmlPreviewKeyDown, true);
    },
    [handleHtmlPreviewKeyDown],
  );

  // Allow Escape to leave the fullscreen HTML preview from either the app
  // window or the preview iframe.
  useEffect(() => {
    window.addEventListener("keydown", handleHtmlPreviewKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleHtmlPreviewKeyDown, true);
      setIframeKeydownListener(
        htmlPreviewFrameRef.current?.contentWindow ?? null,
        handleHtmlPreviewKeyDown,
        false,
      );
    };
  }, [handleHtmlPreviewKeyDown]);

  const relativePath = useMemo(
    () => relativePathForFile(editorFilePath, currentNode, workspaceRoot),
    [editorFilePath, currentNode, workspaceRoot],
  );
  const workspaceRootPath = workspaceRoot?.path ?? null;
  const fileExtension = currentNode?.metadata?.extension ?? fallbackExtension;
  const isImage = isImageFile(fileExtension);
  const isVideo = isVideoFile(fileExtension);
  const isPdf = isPdfFile(fileExtension);
  const isExcalidraw = isExcalidrawFile(fileExtension);
  const isBase = isBaseFile(fileExtension);
  const isHtml = isHtmlFile(fileExtension);
  const isCsv = isCsvFile(fileExtension);
  const isProse = isProseFile(fileExtension);
  // Until the open file's content has loaded the editor still holds the
  // previous file's bytes, so its size says nothing about what is on screen.
  const loadedFileSize =
    loadedFilePath === editorFilePath ? workspaceFile?.size ?? 0 : 0;
  const useLargeTextSafeMode = isLargeTextSafeMode(loadedFileSize);
  const headerPathLabel = currentNode
    ? relativePath ?? currentNode.path.replace(/^\/+/, "")
    : taskRunId
      ? relativePath ?? ""
      : "";

  // Auto-save hook (Obsidian-style: silent, no status UI)
  // Disabled for image/video/pdf/excalidraw files since they have their own save handling.
  // Also disabled when scoped to a task-run worktree — writing back is not yet
  // wired through, and writing to the project main checkout would be wrong.
  const { saveNow, isDirty } = useAutoSave({
    relativePath,
    content,
    enabled:
      !isImage &&
      !isVideo &&
      !isPdf &&
      (!isExcalidraw || useLargeTextSafeMode) &&
      (!isBase || useLargeTextSafeMode) &&
      !workspaceFile?.truncated &&
      !taskRunId &&
      !workspaceRootPath,
    debounceMs: 2000,
  });

  // Save on blur (when editor loses focus)
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;

    const handleBlur = (event: FocusEvent) => {
      // Check if focus is moving outside the editor container
      const relatedTarget = event.relatedTarget as Node | null;
      if (relatedTarget && container.contains(relatedTarget)) return;

      if (isDirty) {
        void saveNow();
      }
    };

    container.addEventListener("focusout", handleBlur);
    return () => container.removeEventListener("focusout", handleBlur);
  }, [isDirty, saveNow]);

  // Save before window/tab close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (isDirty) {
        void saveNow();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty, saveNow]);

  // Handle Ctrl+Z/Ctrl+Y keyboard shortcuts for undo/redo
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;

    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      // Check if the event target is within the editor container
      if (!container.contains(e.target as Node)) return;

      // Handle undo: Ctrl+Z or Cmd+Z
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        (e.key === "z" || e.key === "Z")
      ) {
        e.preventDefault();
        e.stopPropagation();
        editorRef.current?.undo();
        return;
      }

      // Handle redo: Ctrl+Y or Cmd+Y
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        (e.key === "y" || e.key === "Y")
      ) {
        e.preventDefault();
        e.stopPropagation();
        editorRef.current?.redo();
        return;
      }

      // Handle redo: Ctrl+Shift+Z or Cmd+Shift+Z (alternative shortcut)
      if (
        (e.ctrlKey || e.metaKey) &&
        e.shiftKey &&
        (e.key === "z" || e.key === "Z")
      ) {
        e.preventDefault();
        e.stopPropagation();
        editorRef.current?.redo();
        return;
      }

      // Handle find: Ctrl+F or Cmd+F. Intercept here too (in addition to the
      // CodeMirror keymap) so the bar opens even when focus is in the title
      // input or frontmatter, and so the browser's native find never fires.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        e.stopPropagation();
        setIsFindOpen(true);
        return;
      }
    };

    // Use capture phase to intercept before other handlers
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    if (currentNode) {
      setTitleDraft(currentNode.displayName);
      setTitleError(null);
      return;
    }
    setTitleDraft(fallbackDisplayName);
    setTitleError(null);
  }, [currentNode, fallbackDisplayName]);

  useEffect(() => {
    // Skip text file loading for image/video/pdf files - they use dedicated viewers (binary)
    if (isImage || isVideo || isPdf) {
      setWorkspaceFile(null);
      setWorkspaceError(null);
      setWorkspaceLoading(false);
      return;
    }

    if (!editorFilePath || !relativePath) {
      setWorkspaceFile(null);
      setWorkspaceError(null);
      return;
    }
    if (!taskRunId && !workspaceRootPath && !projectId) {
      setWorkspaceFile(null);
      setWorkspaceError(null);
      return;
    }
    let active = true;
    const isExternalReload = loadedFilePath === editorFilePath;
    if (!isExternalReload) {
      setWorkspaceLoading(true);
    }
    setWorkspaceError(null);

    const readPromise = taskRunId
      ? readTaskRunFile(taskRunId, relativePath)
      : workspaceRootPath
        ? readWorkspaceFileAtPath(workspaceRootPath, relativePath)
        : readProjectFile(projectId!, relativePath);

    readPromise
      .then((file) => {
        if (!active) return;
        // Skip frontmatter parsing for non-prose files
        if (isExcalidraw || isBase || !isProse) {
          setWorkspaceFile(file);
          setContent(file.content);
          setFrontmatter({});
          setEditorBody(file.content);
          setLoadedFilePath(editorFilePath);
          return;
        }
        const parsed = parseFrontmatter(file.content);
        setWorkspaceFile(file);
        setContent(file.content);
        setFrontmatter(parsed.frontmatter);
        setEditorBody(parsed.body);
        setLoadedFilePath(editorFilePath);
      })
      .catch((error) => {
        if (!active) return;
        setWorkspaceFile(null);
        setContent("");
        setFrontmatter({});
        setEditorBody("");
        setLoadedFilePath(editorFilePath);
        const raw =
          error instanceof Error ? error.message : "Failed to load file";
        if (raw === "target is not a file") {
          setWorkspaceError("Select a file to view its contents");
        } else if (raw === "path does not exist") {
          setWorkspaceError("File not found");
        } else {
          setWorkspaceError(raw);
        }
      })
      .finally(() => {
        if (active) {
          setWorkspaceLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    editorFilePath,
    isImage,
    isVideo,
    isPdf,
    isExcalidraw,
    isBase,
    isProse,
    projectId,
    relativePath,
    taskRunId,
    workspaceRootPath,
    fileContentVersion,
  ]);

  /**
   * Handle internal link click - navigate to the linked file
   * Obsidian-style: plain click opens, modifiers allow editing
   *
   * Strategy: Local cache first (fast), then API fallback (comprehensive)
   * This gives instant navigation for already-loaded files while ensuring
   * all vault files are reachable.
   */
  const handleInternalLinkClick = useCallback(
    async (linkPath: string) => {
      if (!projectId) {
        console.warn(
          `[FilesEditor] Cannot resolve link without projectId: "${linkPath}"`,
        );
        return;
      }

      // Remove any anchor/section references for now
      const cleanPath = linkPath.split("#")[0];
      // Extract just the filename part (last segment of path)
      const linkFileName = cleanPath.split("/").pop() ?? cleanPath;
      // Normalize: remove .md if present for comparison
      const linkNameWithoutExt = linkFileName.endsWith(".md")
        ? linkFileName.slice(0, -3)
        : linkFileName;
      const linkNameWithExt = `${linkNameWithoutExt}.md`;

      // 1. Fast path: search in already-loaded fileTree, comparing normalized
      // keys so macOS NFD names match typed NFC link text.
      const searchInTree = (nodes: FileNode[]): FileNode | null => {
        for (const node of nodes) {
          if (
            fileNamesEqual(node.name, linkNameWithExt) ||
            fileNamesEqual(node.displayName ?? "", linkNameWithoutExt)
          ) {
            return node;
          }
          if (node.children) {
            const found = searchInTree(node.children);
            if (found) return found;
          }
        }
        return null;
      };

      const cachedNode = searchInTree(fileTree);
      if (cachedNode) {
        openFile(cachedNode.path);
        return;
      }

      // 2. Slow path: the server's name index applies the same rules as chat
      // wikilinks (`.md` appended to extensionless references, shortest path
      // wins among duplicate basenames).
      try {
        const resolved = await resolveProjectFile(projectId, cleanPath);
        if (resolved.relative_path) {
          const normalizedPath = `/${resolved.relative_path}`;
          expandToPath(normalizedPath);
          selectNode(normalizedPath);
          openFile(normalizedPath);
        } else {
          console.warn(
            `[FilesEditor] Link target not found in vault: "${linkPath}"`,
          );
        }
      } catch (error) {
        console.error(
          `[FilesEditor] Error resolving link target: "${linkPath}"`,
          error,
        );
      }
    },
    [projectId, fileTree, expandToPath, selectNode, openFile],
  );

  /**
   * Handle embed click - navigate to the embedded file
   */
  const handleEmbedClick = useCallback(
    (path: string, type: string) => {
      if (type === "note") {
        handleInternalLinkClick(path);
      }
    },
    [handleInternalLinkClick],
  );

  /**
   * Embed configuration for the CodeMirror editor
   */
  const getBinaryFileUrl = useCallback(
    (targetRelativePath: string): string => {
      const base = taskRunId
        ? getTaskRunBinaryFileUrl(taskRunId, targetRelativePath)
        : workspaceRootPath
          ? getWorkspaceBinaryFileUrl(workspaceRootPath, targetRelativePath)
          : projectId
            ? getProjectBinaryFileUrl(projectId, targetRelativePath)
            : "";
      if (!base) return "";
      return fileContentVersion ? `${base}&_v=${fileContentVersion}` : base;
    },
    [projectId, taskRunId, workspaceRootPath, fileContentVersion],
  );

  /**
   * Path-based asset URL used by the HTML preview iframe so that relative
   * `<link>` / `<script>` / `<img>` references inside the served HTML resolve
   * naturally to sibling files via the same endpoint.
   */
  const getAssetUrl = useCallback(
    (targetRelativePath: string): string => {
      const base = taskRunId
        ? getTaskRunAssetUrl(taskRunId, targetRelativePath)
        : workspaceRootPath
          ? getWorkspaceAssetUrl(workspaceRootPath, targetRelativePath)
          : projectId
            ? getProjectAssetUrl(projectId, targetRelativePath)
            : "";
      if (!base) return "";
      return fileContentVersion ? `${base}?_v=${fileContentVersion}` : base;
    },
    [projectId, taskRunId, workspaceRootPath, fileContentVersion],
  );

  /**
   * Source of the preview iframe. `_r` forces a reload on save/refresh, and
   * the bridge flag asks the server to append the link-forwarding script to
   * this document (see `preview-link`). Sub-resources the document pulls in
   * carry neither, so they are served untouched.
   */
  const htmlPreviewSrc = useMemo(() => {
    if (!relativePath) return "";
    const base = getAssetUrl(relativePath);
    if (!base) return "";
    const url = new URL(base);
    url.searchParams.set("_r", String(htmlPreviewKey));
    url.searchParams.set(PREVIEW_LINK_BRIDGE_PARAM, "1");
    return url.toString();
  }, [relativePath, getAssetUrl, htmlPreviewKey]);

  /**
   * Links clicked inside the preview act on the app instead of navigating the
   * frame: a workspace file opens as an editor tab, a web address goes to the
   * system browser. Without this the frame would leave the previewed document
   * behind and render another file's raw bytes.
   */
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const frameWindow = htmlPreviewFrameRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      const message = parsePreviewLinkMessage(event.data);
      if (!message) return;
      const target = resolvePreviewLinkTarget(message, relativePath);
      if (!target) return;
      if (target.kind === "external") {
        openExternalUrl(target.url);
        return;
      }
      openFilePath(target.path, taskRunId);
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [relativePath, taskRunId, openFilePath]);

  const embedConfig: EmbedPluginConfig = useMemo(
    () => ({
      getImageUrl: (path: string) =>
        getBinaryFileUrl(resolveEmbedPath(relativePath, path)),
    }),
    [relativePath, getBinaryFileUrl],
  );

  // Early returns must come AFTER all hooks
  if (!editorFilePath) {
    return (
      <div className="flex h-full w-full flex-1 bg-custom-background-100" />
    );
  }

  // Handle image files with ImageViewer
  if (isImage && relativePath) {
    return (
      <ImageViewer
        relativePath={relativePath}
        fileName={currentNode?.name ?? fallbackFileName}
        contentVersion={fileContentVersion}
        sourceUrl={getBinaryFileUrl(relativePath)}
      />
    );
  }

  // Handle video files with VideoViewer
  if (isVideo && relativePath) {
    return (
      <VideoViewer
        relativePath={relativePath}
        fileName={currentNode?.name ?? fallbackFileName}
        contentVersion={fileContentVersion}
        sourceUrl={getBinaryFileUrl(relativePath)}
      />
    );
  }

  // Handle PDF files with PdfViewer
  if (isPdf && relativePath) {
    return (
      <PdfViewer
        relativePath={relativePath}
        fileName={currentNode?.name ?? fallbackFileName}
        contentVersion={fileContentVersion}
        sourceUrl={getBinaryFileUrl(relativePath)}
      />
    );
  }

  // Oversized text files are returned as a bounded prefix by the backend.
  // Never pass that prefix to an editor: saving it would destroy the unseen
  // tail, and rich-text parsing of the original file is exactly the workload
  // this safe mode is intended to avoid.
  if (workspaceFile?.truncated && loadedFilePath === editorFilePath) {
    return (
      <div className="flex h-full w-full flex-1 flex-col overflow-hidden bg-custom-background-100 font-workspace">
        <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border bg-muted px-4 py-2 text-[12px]">
          <span className="font-medium text-custom-text-100">
            {currentNode?.name ?? fallbackFileName}
          </span>
          <span className="truncate text-muted-foreground">
            {headerPathLabel}
          </span>
        </header>
        <div
          role="status"
          className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-custom-text-200"
        >
          Large file ({formatFileSize(workspaceFile.size)}). Showing a read-only
          preview of the beginning of the file; full editing is disabled to keep
          the app responsive.
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-4 font-mono text-xs leading-5 text-custom-text-200">
          {content}
        </pre>
      </div>
    );
  }

  // Handle Excalidraw files with ExcalidrawEditor
  if (
    isExcalidraw &&
    !useLargeTextSafeMode &&
    relativePath &&
    loadedFilePath === editorFilePath
  ) {
    return (
      <ExcalidrawEditor
        relativePath={relativePath}
        fileName={currentNode?.name ?? fallbackFileName}
        initialContent={content}
        workspaceRootPath={workspaceRootPath ?? undefined}
      />
    );
  }

  // Handle .cbase files with BaseViewer
  if (isBase && !useLargeTextSafeMode && loadedFilePath === editorFilePath) {
    return (
      <BaseViewer
        content={content}
        basePath={relativePath ?? undefined}
        onContentChange={setContent}
      />
    );
  }

  // Handle .csv / .tsv files with the spreadsheet editor. Edits flow back
  // through `setContent`, which the shared auto-save hook persists. Task-run
  // and non-primary workspace roots have no write-back path, so the grid is
  // read-only there (matching how those files are treated elsewhere).
  if (isCsv && !useLargeTextSafeMode && loadedFilePath === editorFilePath) {
    return (
      <CsvEditor
        content={content}
        delimiter={delimiterForExtension(fileExtension)}
        fileName={currentNode?.name ?? fallbackFileName}
        pathLabel={headerPathLabel}
        onChange={setContent}
        readOnly={Boolean(taskRunId) || Boolean(workspaceRootPath)}
      />
    );
  }

  // Show loading state when content hasn't been loaded yet for the current file
  // This prevents showing stale content from the previous file
  const isContentStale = loadedFilePath !== editorFilePath;
  if (isContentStale || workspaceLoading) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center bg-custom-background-100 font-workspace text-sm text-muted-foreground">
        Loading file…
      </div>
    );
  }

  if (workspaceError && !workspaceFile) {
    return (
      <div className="flex h-full w-full flex-1 items-center justify-center bg-custom-background-100 font-workspace text-sm text-muted-foreground">
        {workspaceError}
      </div>
    );
  }

  const handleContentChange = (value: string) => {
    if (frontmatterViewMode === "source") {
      // In source mode, editor contains full content (frontmatter + body)
      // Parse and update both frontmatter and body
      const parsed = parseFrontmatter(value);
      setFrontmatter(parsed.frontmatter);
      setEditorBody(parsed.body);
      setContent(value);
    } else {
      // In UI mode, editor only receives the body (without frontmatter)
      // Reconstruct full content with current frontmatter
      setEditorBody(value);
      const fullContent = combineFrontmatterAndBody(frontmatter, value);
      setContent(fullContent);
    }
  };

  const handleFrontmatterChange = (newFrontmatter: Frontmatter) => {
    setFrontmatter(newFrontmatter);
    const fullContent = combineFrontmatterAndBody(newFrontmatter, editorBody);
    setContent(fullContent);
  };

  const handleViewModeChange = (mode: FrontmatterViewMode) => {
    setFrontmatterViewMode(mode);
    // When switching modes, we need to update the editor content
    // The editor will re-render with the appropriate content based on mode
  };

  // Content to show in the editor depends on view mode
  const editorContent = frontmatterViewMode === "source" ? content : editorBody;
  const commitTitleChange = async () => {
    if (!currentNode) return;
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setTitleError("Title is required");
      setTitleDraft(currentNode.displayName);
      return;
    }
    if (trimmed === currentNode.displayName) {
      setTitleError(null);
      return;
    }

    setIsRenamingTitle(true);
    try {
      await renameDisplayName(currentNode.path, trimmed);
      setTitleError(null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to rename file";
      setTitleError(message);
      setTitleDraft(currentNode.displayName);
    } finally {
      setIsRenamingTitle(false);
    }
  };

  const handleTitleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setTitleDraft(event.target.value);
    if (titleError) {
      setTitleError(null);
    }
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void commitTitleChange();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (currentNode) {
        setTitleDraft(currentNode.displayName);
      }
      setTitleError(null);
    }
  };

  const handleTitleBlur = () => {
    void commitTitleChange();
  };

  // Code file layout: no title editing, no frontmatter, line numbers
  if (!isProse || useLargeTextSafeMode) {
    const codeView = resolveCodeViewState({
      fileSizeBytes: loadedFileSize,
      isHtml,
      htmlViewMode,
      fullscreenRequested: isHtmlFullscreen,
    });
    const { showHtmlPreview } = codeView;
    const htmlFullscreen = codeView.showHtmlFullscreen;
    const codeLayout = (
      <div
        className={cn(
          "flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace text-[13px] leading-[1.4]",
          htmlFullscreen && "fixed inset-0 z-[200]",
        )}
      >
        <div
          ref={editorContainerRef}
          className="flex flex-1 flex-col overflow-hidden bg-custom-background-100"
        >
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted px-4 text-[12px] text-muted-foreground">
            <span className="font-medium text-custom-text-100">
              {currentNode?.name ?? fallbackFileName}
            </span>
            <span className="text-muted-foreground">{headerPathLabel}</span>
            {codeView.showHtmlToolbar && (
              <div className="ml-auto flex items-center gap-1">
                {htmlViewMode === "preview" && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={async () => {
                        if (isDirty) await saveNow();
                        setHtmlPreviewKey((k) => k + 1);
                      }}
                      title="Refresh preview"
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant={isHtmlFullscreen ? "secondary" : "ghost"}
                      size="icon"
                      className="size-6"
                      onClick={() => setIsHtmlFullscreen((value) => !value)}
                      title={
                        isHtmlFullscreen
                          ? "Exit fullscreen (Esc)"
                          : "Fullscreen preview"
                      }
                    >
                      {isHtmlFullscreen ? (
                        <Minimize2 className="size-3.5" />
                      ) : (
                        <Maximize2 className="size-3.5" />
                      )}
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  variant={htmlViewMode === "preview" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={async () => {
                    // Switching to preview: flush any pending edits first so the
                    // iframe loads the latest on-disk content.
                    if (isDirty) await saveNow();
                    setHtmlPreviewKey((k) => k + 1);
                    setHtmlViewMode("preview");
                  }}
                  title="Preview rendered HTML"
                >
                  <Eye className="size-3.5" />
                  Preview
                </Button>
                <Button
                  type="button"
                  variant={htmlViewMode === "raw" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={() => {
                    setIsHtmlFullscreen(false);
                    setHtmlViewMode("raw");
                  }}
                  title="View raw source"
                >
                  <Code className="size-3.5" />
                  Raw
                </Button>
              </div>
            )}
          </header>
          {codeView.showSafeModeNotice && (
            <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-custom-text-200">
              Large text file ({formatFileSize(loadedFileSize)}).{" "}
              {isProse
                ? "Rich-text rendering, syntax highlighting, and line wrapping"
                : "Syntax highlighting and line wrapping"}{" "}
              are disabled; editing remains available in plain-text mode.
            </div>
          )}
          <div className="flex flex-1 flex-col overflow-hidden">
            {showHtmlPreview && htmlPreviewSrc ? (
              <iframe
                ref={htmlPreviewFrameRef}
                key={`${loadedFilePath ?? ""}-${htmlPreviewKey}`}
                title={currentNode?.name ?? fallbackFileName}
                src={htmlPreviewSrc}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                className="h-full w-full flex-1 border-0 bg-white"
                onLoad={handleHtmlPreviewLoad}
              />
            ) : (
              <div className="show-scrollbar flex flex-1 flex-col overflow-y-auto">
                <div className="chro-find-bar-mount px-3 pt-2">
                  <EditorFindBar
                    open={isFindOpen}
                    query={findQuery}
                    onQueryChange={setFindQuery}
                    onClose={closeFindBar}
                    editorRef={editorRef}
                  />
                </div>
                <CodeMirrorEditor
                  key={
                    codeView.largeTextSafeMode
                      ? `large-safe-${loadedFilePath ?? ""}`
                      : "standard-code-editor"
                  }
                  ref={editorRef}
                  contentKey={loadedFilePath ?? ""}
                  initialContent={content}
                  onChange={(value) => setContent(value)}
                  className="min-h-0 h-full w-full flex-1"
                  mode="code"
                  lineWrapping={codeView.lineWrapping}
                  fileExtension={
                    codeView.syntaxHighlighting
                      ? fileExtension ?? undefined
                      : undefined
                  }
                  onFindRequest={openFindBar}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
    // Fullscreen renders through a portal so the preview escapes the editor
    // pane's stacking context and covers the right dock / sidebars.
    return htmlFullscreen
      ? createPortal(codeLayout, document.body)
      : codeLayout;
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace text-[13px] leading-[1.4]">
      <div
        ref={editorContainerRef}
        className="flex flex-1 flex-col overflow-hidden bg-custom-background-100"
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          <div
            className="show-scrollbar flex flex-1 flex-col overflow-y-auto py-8"
            style={{ containerType: "inline-size" }}
          >
            <div className="mx-auto flex w-full max-w-[800px] flex-1 flex-col box-border px-[clamp(24px,6cqi,50px)]">
              <div className="chro-find-bar-mount">
                <EditorFindBar
                  open={isFindOpen}
                  query={findQuery}
                  onQueryChange={setFindQuery}
                  onClose={closeFindBar}
                  editorRef={editorRef}
                />
              </div>
              <div className="flex flex-col gap-2">
                <TextareaAutosize
                  minRows={1}
                  value={titleDraft}
                  disabled={isRenamingTitle || !currentNode}
                  onChange={handleTitleChange}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={handleTitleBlur}
                  onFocus={(event) => event.currentTarget.select()}
                  spellCheck={false}
                  aria-label="Document title"
                  className={cn(
                    "w-full resize-none overflow-hidden bg-transparent pb-1 text-left text-[20px] font-semibold leading-tight text-custom-text-100 outline-none",
                    "border-b border-transparent transition-colors duration-200 focus:border-[#299ad6]",
                    titleError &&
                      "border-destructive text-destructive focus:border-destructive",
                  )}
                />
                {titleError && (
                  <span className="text-[12px] leading-none text-destructive">
                    {titleError}
                  </span>
                )}
              </div>
              <FrontmatterEditor
                frontmatter={frontmatter}
                onChange={handleFrontmatterChange}
                viewMode={frontmatterViewMode}
                onViewModeChange={handleViewModeChange}
                className="mt-3"
              />
              <div className="mt-4 flex flex-1 min-h-0">
                <CodeMirrorEditor
                  ref={editorRef}
                  contentKey={`${loadedFilePath ?? ""}-${frontmatterViewMode}`}
                  initialContent={editorContent}
                  onChange={handleContentChange}
                  className="min-h-0 h-full w-full flex-1"
                  renderBubbleMenu={(view) => <FormattingMenu view={view} />}
                  onInternalLinkClick={handleInternalLinkClick}
                  embedConfig={embedConfig}
                  onEmbedClick={handleEmbedClick}
                  onFindRequest={openFindBar}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
