
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import TextareaAutosize from "react-textarea-autosize";
import { cn } from "@chro/ui/utils";
import { useFilesStore } from "../../state/files-store";
import { useFileTreeStore } from "../../state/file-tree-store";
import type { FileNode } from "../../types/file-tree";
import type { DesktopWorkspaceFile } from "@/types/desktop";
import {
  readProjectFile,
  getProjectBinaryFileUrl,
  searchProjectFiles,
} from "@/lib/project-client";
import { useProjectId } from "../../context/project-context";
import { CodeMirrorEditor, type CodeMirrorEditorHandle } from "./codemirror";
import { FormattingMenu } from "./codemirror/plugins/bubble-menu";
import type { EmbedPluginConfig } from "./codemirror/plugins/prose";
import { ImageViewer } from "./image-viewer";
import { VideoViewer } from "./video-viewer";
import { PdfViewer } from "./pdf-viewer";
import { ExcalidrawEditor } from "./excalidraw-editor";
import { BaseViewer } from "../../../cbase/components/lens-viewer";
import { useAutoSave } from "../../hooks/use-auto-save";
import {
  FrontmatterEditor,
  type FrontmatterViewMode,
} from "./frontmatter-editor";
import {
  parseFrontmatter,
  combineFrontmatterAndBody,
  type Frontmatter,
} from "../../lib/frontmatter";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "avif",
]);

const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "webm",
  "mov",
  "avi",
  "mkv",
]);

const PDF_EXTENSIONS = new Set(["pdf"]);

const EXCALIDRAW_EXTENSIONS = new Set(["excalidraw"]);

const BASE_EXTENSIONS = new Set(["cbase"]);

/** Extensions rendered as prose (WYSIWYG markdown editor) */
const PROSE_EXTENSIONS = new Set(["md", "mdx", "txt"]);

const isProseFile = (extension?: string | null): boolean => {
  if (!extension) return true; // default to prose for extensionless files
  return PROSE_EXTENSIONS.has(extension.toLowerCase());
};

const isImageFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
};

const isVideoFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return VIDEO_EXTENSIONS.has(extension.toLowerCase());
};

const isPdfFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return PDF_EXTENSIONS.has(extension.toLowerCase());
};

const isExcalidrawFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return EXCALIDRAW_EXTENSIONS.has(extension.toLowerCase());
};

const isBaseFile = (extension?: string | null): boolean => {
  if (!extension) return false;
  return BASE_EXTENSIONS.has(extension.toLowerCase());
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

const computeStats = (content: string) => {
  const words = content.split(/\s+/).filter(Boolean).length;
  const characters = content.length;
  const lines = content.split(/\n/).length;
  return { words, characters, lines };
};

const formatTimestamp = (value?: string | null): string => {
  const date = new Date(value ?? new Date().toISOString());
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const FilesEditor = () => {
  const projectId = useProjectId();
  const {
    currentFilePath,
    fileTree,
    renameDisplayName,
    openFile,
    selectNode,
    fileContentVersion,
  } = useFilesStore();
  const { expandToPath } = useFileTreeStore();
  const editorRef = useRef<CodeMirrorEditorHandle>(null);
  const currentNode = useMemo(
    () => findNodeByPath(fileTree, currentFilePath),
    [fileTree, currentFilePath],
  );

  const fallbackFileName = useMemo(() => {
    const path = currentFilePath ?? "";
    const cleaned = path.replace(/^\/+/, "");
    return cleaned.split("/").pop() ?? "";
  }, [currentFilePath]);

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

  // Frontmatter state - parsed from content
  const [frontmatter, setFrontmatter] = useState<Frontmatter>({});
  const [editorBody, setEditorBody] = useState<string>("");
  const [frontmatterViewMode, setFrontmatterViewMode] =
    useState<FrontmatterViewMode>("ui");

  const relativePath = currentFilePath
    ? currentFilePath.replace(/^\/+/, "")
    : null;
  const fileExtension = currentNode?.metadata?.extension ?? fallbackExtension;
  const isImage = isImageFile(fileExtension);
  const isVideo = isVideoFile(fileExtension);
  const isPdf = isPdfFile(fileExtension);
  const isExcalidraw = isExcalidrawFile(fileExtension);
  const isBase = isBaseFile(fileExtension);
  const isProse = isProseFile(fileExtension);
  const headerPathLabel = currentNode
    ? relativePath ?? currentNode.path.replace(/^\/+/, "")
    : "";

  // Auto-save hook (Obsidian-style: silent, no status UI)
  // Disabled for image/video/pdf/excalidraw files since they have their own save handling
  const { saveNow, isDirty } = useAutoSave({
    relativePath,
    content,
    enabled: !isImage && !isVideo && !isPdf && !isExcalidraw && !isBase,
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

    if (!currentFilePath || !projectId) {
      setWorkspaceFile(null);
      setWorkspaceError(null);
      return;
    }
    let active = true;
    const isExternalReload = loadedFilePath === currentFilePath;
    if (!isExternalReload) {
      setWorkspaceLoading(true);
    }
    setWorkspaceError(null);
    const fileRelativePath = currentFilePath.replace(/^\/+/, "");

    readProjectFile(projectId, fileRelativePath)
      .then((file) => {
        if (!active) return;
        // Skip frontmatter parsing for non-prose files
        if (isExcalidraw || isBase || !isProse) {
          setWorkspaceFile(file);
          setContent(file.content);
          setFrontmatter({});
          setEditorBody(file.content);
          setLoadedFilePath(currentFilePath);
          return;
        }
        const parsed = parseFrontmatter(file.content);
        setWorkspaceFile(file);
        setContent(file.content);
        setFrontmatter(parsed.frontmatter);
        setEditorBody(parsed.body);
        setLoadedFilePath(currentFilePath);
      })
      .catch((error) => {
        if (!active) return;
        setWorkspaceFile(null);
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
  }, [currentFilePath, isImage, isVideo, isPdf, isExcalidraw, isBase, isProse, projectId, fileContentVersion]);

  const stats = useMemo(() => computeStats(content), [content]);

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

      // 1. Fast path: search in already-loaded fileTree
      const searchInTree = (nodes: FileNode[]): FileNode | null => {
        for (const node of nodes) {
          if (
            node.name === linkNameWithExt ||
            node.displayName === linkNameWithoutExt
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

      // 2. Slow path: API search for files not yet loaded
      try {
        const results = await searchProjectFiles(
          projectId,
          linkNameWithoutExt,
          { limit: 10 },
        );

        // Find best match: prefer exact filename match
        const exactMatch = results.find(
          (r) =>
            r.is_file &&
            (r.path.endsWith(`/${linkNameWithExt}`) ||
              r.path === linkNameWithExt),
        );
        const fileMatch = exactMatch ?? results.find((r) => r.is_file);

        if (fileMatch) {
          const normalizedPath = fileMatch.path.startsWith("/")
            ? fileMatch.path
            : `/${fileMatch.path}`;
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
          `[FilesEditor] Error searching for link target: "${linkPath}"`,
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
  const embedConfig: EmbedPluginConfig = useMemo(
    () => ({
      getImageUrl: (path: string) => {
        // Resolve relative path from current file's directory
        const currentDir = relativePath
          ? relativePath.substring(0, relativePath.lastIndexOf("/"))
          : "";
        let resolvedPath: string;

        if (path.startsWith("/")) {
          resolvedPath = path.replace(/^\/+/, "");
        } else if (currentDir) {
          resolvedPath = `${currentDir}/${path}`;
        } else {
          resolvedPath = path;
        }

        // Normalize the path (handle ../ and ./)
        const parts = resolvedPath.split("/").filter(Boolean);
        const resolved: string[] = [];
        for (const part of parts) {
          if (part === "..") {
            resolved.pop();
          } else if (part !== ".") {
            resolved.push(part);
          }
        }

        if (!projectId) return "";
        const base = getProjectBinaryFileUrl(projectId, resolved.join("/"));
        return fileContentVersion ? `${base}&_v=${fileContentVersion}` : base;
      },
    }),
    [relativePath, projectId, fileContentVersion],
  );

  // Early returns must come AFTER all hooks
  if (!currentFilePath) {
    return <div className="flex h-full w-full flex-1 bg-custom-background-100" />;
  }

  // Handle image files with ImageViewer
  if (isImage && relativePath) {
    return (
      <ImageViewer
        relativePath={relativePath}
        fileName={currentNode?.name ?? fallbackFileName}
        contentVersion={fileContentVersion}
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
      />
    );
  }

  // Handle Excalidraw files with ExcalidrawEditor
  if (isExcalidraw && relativePath && loadedFilePath === currentFilePath) {
    return (
      <ExcalidrawEditor
        relativePath={relativePath}
        fileName={currentNode?.name ?? fallbackFileName}
        initialContent={content}
      />
    );
  }

  // Handle .cbase files with BaseViewer
  if (isBase && loadedFilePath === currentFilePath) {
    return (
      <BaseViewer
        content={content}
        basePath={relativePath ?? undefined}
        onContentChange={setContent}
      />
    );
  }

  // Show loading state when content hasn't been loaded yet for the current file
  // This prevents showing stale content from the previous file
  const isContentStale = loadedFilePath !== currentFilePath;
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
  if (!isProse) {
    return (
      <div className="flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace text-[13px] leading-[1.4]">
        <div
          ref={editorContainerRef}
          className="flex flex-1 flex-col overflow-hidden bg-custom-background-100"
        >
          <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted px-4 text-[12px] text-muted-foreground">
            <span className="font-medium text-custom-text-100">
              {currentNode?.name ?? fallbackFileName}
            </span>
            <span className="text-muted-foreground">{headerPathLabel}</span>
          </header>
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="show-scrollbar flex flex-1 flex-col overflow-y-auto">
              <CodeMirrorEditor
                ref={editorRef}
                contentKey={loadedFilePath ?? ""}
                initialContent={content}
                onChange={(value) => setContent(value)}
                className="min-h-0 h-full w-full flex-1"
                mode="code"
                fileExtension={fileExtension ?? undefined}
              />
            </div>
          </div>
          <footer className="flex h-10 items-center gap-4 border-t border-border bg-muted px-5 text-[12px] text-muted-foreground">
            <span>Modified {formatTimestamp(workspaceFile?.modifiedAt)}</span>
            <span>Lines {stats.lines}</span>
            <span>Chars {stats.characters}</span>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col bg-custom-background-100 font-workspace text-[13px] leading-[1.4]">
      <div
        ref={editorContainerRef}
        className="flex flex-1 flex-col overflow-hidden bg-custom-background-100"
      >
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="show-scrollbar flex flex-1 flex-col overflow-y-auto px-10 py-8">
            <div className="mx-auto flex w-full max-w-[800px] flex-1 flex-col box-border px-[50px]">
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
                />
              </div>
            </div>
          </div>
        </div>
        <footer className="flex h-10 items-center gap-4 border-t border-border bg-muted px-5 text-[12px] text-muted-foreground">
          <span>Modified {formatTimestamp(workspaceFile?.modifiedAt)}</span>
          <span>Words {stats.words}</span>
          <span>Chars {stats.characters}</span>
          <span>Lines {stats.lines}</span>
        </footer>
      </div>
    </div>
  );
};
