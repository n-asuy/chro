import { useLanguage } from "@/i18n";
import {
  type BaseCodingAgent,
  type ExecutorConfigs,
  type ExecutorProfileId,
  fetchExecutorProfile,
} from "@/lib/executor-client";
import { type BranchInfo, listGitBranches } from "@/lib/git-client";
import {
  type ProjectSearchResult,
  searchProjectFiles,
} from "@/lib/project-client";
import type { ContextEntry } from "@/session/types/context";
import {
  formatContextForPrompt,
  inferTaskDescriptionFromContent,
  inferTaskTitleFromContent,
} from "@/session/types/context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@chro/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";
import { cn } from "@chro/ui/utils";
import {
  Check,
  ChevronDown,
  Command,
  FileText,
  Folder,
  GitBranch,
  ImageIcon,
  Laptop,
  Search,
} from "lucide-react";
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DEFAULT_EXECUTORS: BaseCodingAgent[] = ["CLAUDE_CODE", "CODEX"];

export type AddTaskSubmitOptions = {
  runImmediately?: boolean;
  useWorktree?: boolean;
  executorProfileId?: ExecutorProfileId | null;
  targetBranch?: string;
};

export interface AddTaskPayload {
  title: string;
  summary?: string;
  prompt?: string;
}

interface AddTaskPanelProps {
  isOpen: boolean;
  projectId: string | null;
  onClose: () => void;
  onSubmit: (payload: AddTaskPayload, options?: AddTaskSubmitOptions) => void;
  /** "popover" renders inline (sidebar), "modal" renders as centered portal */
  variant?: "popover" | "modal";
  /** Popover placement relative to the trigger. "right" = sidebar style, "top" = kanban footer, "bottom" = kanban header */
  placement?: "right" | "top" | "bottom";
}

// ---------------------------------------------------------------------------
// @ file picker helpers
// ---------------------------------------------------------------------------

const AT_DEBOUNCE_MS = 150;

function getAtQuery(el: HTMLElement): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;

  // Walk backwards from cursor to find @
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent ?? "";
  const offset = range.startOffset;
  const before = text.slice(0, offset);
  const atMatch = before.match(/@(\S*)$/);
  return atMatch ? atMatch[1] : null;
}

function insertFilePill(el: HTMLElement, path: string, isFile: boolean): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return;

  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return;
  const text = node.textContent ?? "";
  const offset = range.startOffset;
  const before = text.slice(0, offset);
  const atIdx = before.lastIndexOf("@");
  if (atIdx === -1) return;

  // Delete @ and query text
  const deleteRange = document.createRange();
  deleteRange.setStart(node, atIdx);
  deleteRange.setEnd(node, offset);
  deleteRange.deleteContents();

  // Create pill
  const displayName = path.split("/").pop() ?? path;
  const pill = document.createElement("span");
  pill.dataset.type = "file";
  pill.dataset.path = path;
  pill.dataset.isFile = String(isFile);
  pill.contentEditable = "false";
  pill.textContent = `@${displayName}`;

  // Insert at cursor
  const insertRange = sel.getRangeAt(0);
  insertRange.collapse(false);
  insertRange.insertNode(pill);

  // Add trailing space
  const space = document.createTextNode("\u00A0");
  pill.after(space);

  // Move cursor after space
  const newRange = document.createRange();
  newRange.setStartAfter(space);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

function parseEditorContent(el: HTMLElement): {
  text: string;
  contextEntries: ContextEntry[];
} {
  const entries: ContextEntry[] = [];
  const seen = new Set<string>();
  let text = "";

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Convert non-breaking spaces back to regular spaces
      text += (node.textContent ?? "").replace(/\u00A0/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const elem = node as HTMLElement;

    if (elem.dataset.type === "file") {
      const path = elem.dataset.path ?? "";
      if (path && !seen.has(path)) {
        seen.add(path);
        entries.push({ path, isFile: elem.dataset.isFile === "true" });
      }
      return;
    }

    // Block-level elements produce newlines
    const tag = elem.tagName;
    if (tag === "DIV" || tag === "P" || tag === "BR") {
      if (text.length > 0 && !text.endsWith("\n")) {
        text += "\n";
      }
      if (tag === "BR") return;
    }

    for (const child of Array.from(elem.childNodes)) {
      walk(child);
    }
  }

  walk(el);
  return { text: text.trim(), contextEntries: entries };
}

// ---------------------------------------------------------------------------
// AddTaskPanel
// ---------------------------------------------------------------------------

export const AddTaskPanel: React.FC<AddTaskPanelProps> = ({
  isOpen,
  projectId,
  onClose,
  onSubmit,
  variant = "popover",
  placement = "right",
}) => {
  const { t } = useLanguage();
  const [useWorktree, setUseWorktree] = useState(true);
  const [isGitRepository, setIsGitRepository] = useState(true);
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [baseBranchCandidates, setBaseBranchCandidates] = useState<
    BranchInfo[]
  >([]);
  const [isLoadingBaseBranches, setIsLoadingBaseBranches] = useState(false);
  const [baseBranchSearch, setBaseBranchSearch] = useState("");
  const [executorProfileId, setExecutorProfileId] =
    useState<ExecutorProfileId | null>(null);
  const [executorConfigs, setExecutorConfigs] =
    useState<ExecutorConfigs | null>(null);
  const [executorProfileLoading, setExecutorProfileLoading] = useState(true);
  const [sessionExecutorProfile, setSessionExecutorProfile] =
    useState<ExecutorProfileId | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [hasContent, setHasContent] = useState(false);

  // @ popover state
  const [atOpen, setAtOpen] = useState(false);
  const [atQuery, setAtQuery] = useState("");
  const [atActiveIndex, setAtActiveIndex] = useState(0);

  const filteredBaseBranches = useMemo(() => {
    const q = baseBranchSearch.trim().toLowerCase();
    if (!q) return baseBranchCandidates;
    return baseBranchCandidates.filter((b) => b.name.toLowerCase().includes(q));
  }, [baseBranchCandidates, baseBranchSearch]);

  useEffect(() => {
    if (!isOpen) return;
    setImageFiles([]);
    setAtOpen(false);
    setAtQuery("");
    setHasContent(false);
    requestAnimationFrame(() => {
      if (editorRef.current) {
        editorRef.current.textContent = "";
        editorRef.current.focus();
      }
    });
  }, [isOpen]);

  // Click outside to close — ignore clicks on portaled dropdown content
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // Radix portals dropdown content outside the panel; don't close on those clicks
      if (target.closest("[data-radix-popper-content-wrapper]")) return;
      if (panelRef.current && !panelRef.current.contains(target)) {
        onClose();
      }
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (atOpen) {
        setAtOpen(false);
        return;
      }
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose, atOpen]);

  useEffect(() => {
    setUseWorktree(true);
    setIsGitRepository(true);
  }, [projectId]);

  useEffect(() => {
    if (!isOpen || !projectId) {
      setBaseBranchCandidates([]);
      setBaseBranch(null);
      setIsGitRepository(true);
      return;
    }
    let cancelled = false;
    setIsLoadingBaseBranches(true);
    listGitBranches(projectId)
      .then(({ branches, isRepository }) => {
        if (cancelled) return;
        setIsGitRepository(isRepository);
        if (!isRepository) {
          setUseWorktree(false);
          setBaseBranchCandidates([]);
          setBaseBranch(null);
          return;
        }
        const localBranches = branches.filter((b) => !b.is_remote);
        setBaseBranchCandidates(localBranches);
        const current = localBranches.find((b) => b.is_current);
        if (current && !baseBranch) {
          setBaseBranch(current.name);
        }
      })
      .catch((err) => {
        console.error("[add-task-panel] Failed to fetch branches", err);
        if (!cancelled) setBaseBranchCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingBaseBranches(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId]);

  useEffect(() => {
    let cancelled = false;
    const loadExecutorProfile = async () => {
      setExecutorProfileLoading(true);
      try {
        const response = await fetchExecutorProfile();
        if (cancelled) return;
        setExecutorProfileId(response.profile);
        setExecutorConfigs(response.profiles);
        setSessionExecutorProfile((prev) => prev ?? response.profile);
      } catch (error) {
        if (cancelled) return;
        setExecutorConfigs(null);
        console.warn("[add-task-panel] Failed to load executor profile", error);
      } finally {
        if (!cancelled) setExecutorProfileLoading(false);
      }
    };
    void loadExecutorProfile();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableExecutors = useMemo(() => {
    if (!executorConfigs) return DEFAULT_EXECUTORS;
    const executors = Object.keys(
      executorConfigs.executors,
    ) as BaseCodingAgent[];
    return executors.length ? executors : DEFAULT_EXECUTORS;
  }, [executorConfigs]);

  const executorLabels = useMemo(
    () => ({
      CLAUDE_CODE: t("mcpExecutorOptionClaude"),
      CODEX: t("mcpExecutorOptionCodex"),
    }),
    [t],
  );

  const sessionExecutorSelection = sessionExecutorProfile ?? executorProfileId;
  const executorDisplayLabel = useMemo(() => {
    if (!sessionExecutorSelection) return t("claudeModelUnknown");
    return (
      executorLabels[sessionExecutorSelection.executor] ??
      sessionExecutorSelection.executor
    );
  }, [executorLabels, sessionExecutorSelection, t]);
  const executorSelectorLabel = executorProfileLoading
    ? t("loadingMessage")
    : executorDisplayLabel;

  const handleClose = useCallback(() => {
    setImageFiles([]);
    setAtOpen(false);
    onClose();
  }, [onClose]);

  const getEditorPayload = useCallback(() => {
    if (!editorRef.current) return null;
    const { text, contextEntries } = parseEditorContent(editorRef.current);
    if (!text && contextEntries.length === 0) return null;
    const contextPrefix = formatContextForPrompt(contextEntries);
    const prompt = contextPrefix ? `${contextPrefix}\n${text}` : text;
    return {
      title: inferTaskTitleFromContent(prompt),
      summary: inferTaskDescriptionFromContent(prompt) ?? undefined,
      prompt,
    };
  }, []);

  const submitTask = useCallback(
    (options?: AddTaskSubmitOptions) => {
      const payload = getEditorPayload();
      if (!payload) return;
      const executorProfilePayload =
        sessionExecutorSelection ?? executorProfileId;
      onSubmit(
        {
          title: payload.title,
          summary: payload.summary,
          prompt: payload.prompt,
        },
        {
          runImmediately: options?.runImmediately,
          useWorktree,
          executorProfileId: executorProfilePayload ?? undefined,
          targetBranch: baseBranch ?? undefined,
        },
      );
      handleClose();
    },
    [
      getEditorPayload,
      sessionExecutorSelection,
      executorProfileId,
      useWorktree,
      baseBranch,
      onSubmit,
      handleClose,
    ],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      submitTask({ runImmediately: true });
    },
    [submitTask],
  );

  const handleCreateTaskOnly = useCallback(() => {
    if (!hasContent) return;
    submitTask({ runImmediately: false });
  }, [hasContent, submitTask]);

  // ContentEditable input handler — detect @ trigger
  const handleInput = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const { text, contextEntries } = parseEditorContent(el);
    setHasContent(text.length > 0 || contextEntries.length > 0);

    const q = getAtQuery(el);
    if (q !== null) {
      setAtOpen(true);
      setAtQuery(q);
    } else {
      setAtOpen(false);
      setAtQuery("");
    }
  }, []);

  const handleEditorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      // When @ popover is open, delegate arrow/enter/escape to it
      if (atOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          // We handle index changes via the popover's keyboard handler below
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          // Selection will be triggered via the ref callback
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setAtOpen(false);
          return;
        }
      }

      // Cmd/Ctrl+Enter to submit
      if (event.key === "Enter") {
        if (event.nativeEvent.isComposing) return;
        if (event.metaKey || event.ctrlKey) {
          if (!hasContent) return;
          event.preventDefault();
          formRef.current?.requestSubmit();
          return;
        }
        // Allow regular Enter for newlines (Shift+Enter is also fine)
      }
    },
    [atOpen, hasContent],
  );

  // Expose keyboard handler for the @ popover items (arrow navigation + select)
  const atPopoverKeyHandlerRef = useRef<{
    results: ProjectSearchResult[];
  }>({ results: [] });

  // Unified keydown that also handles @ popover navigation
  const handleEditorKeyDownWithPopover = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (atOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setAtActiveIndex((prev) =>
            Math.min(
              prev + 1,
              (atPopoverKeyHandlerRef.current.results.length || 1) - 1,
            ),
          );
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setAtActiveIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          const results = atPopoverKeyHandlerRef.current.results;
          const item = results[atActiveIndex];
          if (item && editorRef.current) {
            insertFilePill(editorRef.current, item.path, item.is_file);
            setAtOpen(false);
            setAtQuery("");
            // Update content state
            const { text, contextEntries } = parseEditorContent(
              editorRef.current,
            );
            setHasContent(text.length > 0 || contextEntries.length > 0);
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setAtOpen(false);
          return;
        }
      }
      handleEditorKeyDown(event);
    },
    [atOpen, atActiveIndex, handleEditorKeyDown],
  );

  const handleFileSelect = useCallback((path: string, isFile: boolean) => {
    if (!editorRef.current) return;
    insertFilePill(editorRef.current, path, isFile);
    setAtOpen(false);
    setAtQuery("");
    const { text, contextEntries } = parseEditorContent(editorRef.current);
    setHasContent(text.length > 0 || contextEntries.length > 0);
    editorRef.current.focus();
  }, []);

  const handleExecutorSelect = useCallback(
    (executor: BaseCodingAgent) => {
      const variant =
        executorProfileId?.executor === executor
          ? executorProfileId.variant ?? null
          : null;
      setSessionExecutorProfile({ executor, variant });
    },
    [executorProfileId],
  );

  const handleSelectFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files) return;
      setImageFiles((prev) => [...prev, ...Array.from(files)]);
      // Reset to allow re-selecting the same file
      event.target.value = "";
    },
    [],
  );

  if (!isOpen) return null;

  const popoverPlacementClass =
    placement === "top"
      ? "absolute bottom-full left-0 z-30 mb-2 w-[580px] font-workspace text-[12px] leading-[1.35] animate-in fade-in slide-in-from-bottom-1 duration-100"
      : placement === "bottom"
        ? "absolute top-full left-0 z-30 mt-2 w-[580px] font-workspace text-[12px] leading-[1.35] animate-in fade-in slide-in-from-top-1 duration-100"
        : "absolute left-full top-0 z-30 ml-2 w-[580px] font-workspace text-[12px] leading-[1.35] animate-in fade-in slide-in-from-left-1 duration-100";

  const panelContent = (
    <div
      ref={panelRef}
      className={
        variant === "popover"
          ? popoverPlacementClass
          : "w-full max-w-2xl font-workspace text-[12px] leading-[1.35] animate-in fade-in duration-100"
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        className="sr-only"
        onChange={handleFileChange}
      />
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="flex flex-col w-full"
      >
        <div className="flex flex-col gap-3 rounded-2xl border border-[#D9D9E3] bg-background p-4 shadow-md dark:border-[#3F3F46]">
          {/* Image previews */}
          {imageFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 -mt-1">
              {imageFiles.map((file, i) => (
                <div
                  key={`${file.name}-${i}`}
                  className="relative h-12 w-12 rounded border border-border overflow-hidden"
                >
                  <img
                    src={URL.createObjectURL(file)}
                    alt={file.name}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setImageFiles((prev) =>
                        prev.filter((_, idx) => idx !== i),
                      )
                    }
                    className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background text-[10px] leading-none hover:bg-destructive"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ContentEditable editor with @ file picker */}
          <div className="relative">
            <FilePopoverWithResults
              open={atOpen}
              query={atQuery}
              projectId={projectId}
              activeIndex={atActiveIndex}
              onActiveIndexChange={setAtActiveIndex}
              onSelect={handleFileSelect}
              resultsRef={atPopoverKeyHandlerRef}
            />
            <div
              ref={editorRef}
              contentEditable="plaintext-only"
              role="textbox"
              data-placeholder="Ask Agent anything..."
              onInput={handleInput}
              onKeyDown={handleEditorKeyDownWithPopover}
              className={cn(
                "min-h-[56px] max-h-48 w-full resize-none border-none bg-transparent p-0 text-sm leading-relaxed text-foreground shadow-none outline-none overflow-y-auto whitespace-pre-wrap break-words",
                "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none",
                // File pill styles
                "[&_[data-type=file]]:inline-flex [&_[data-type=file]]:items-center [&_[data-type=file]]:rounded [&_[data-type=file]]:bg-blue-50 [&_[data-type=file]]:px-1 [&_[data-type=file]]:text-blue-600 [&_[data-type=file]]:text-xs [&_[data-type=file]]:font-medium [&_[data-type=file]]:mx-0.5 [&_[data-type=file]]:cursor-default",
              )}
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              {/* Image attachment */}
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleSelectFiles}
                      className={`flex h-9 w-9 items-center justify-center rounded-[4px] text-muted-foreground transition hover:bg-muted/40 hover:text-primary ${imageFiles.length > 0 ? "bg-primary/10 text-primary" : ""}`}
                    >
                      <ImageIcon className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">
                    {t("attachmentButtonAria")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>

              <div className="mx-1 h-4 w-px bg-border" />

              {/* Executor selector */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={
                      executorProfileLoading || availableExecutors.length === 0
                    }
                    className="flex h-9 items-center justify-center gap-1.5 rounded-[4px] px-2 text-xs font-medium text-muted-foreground transition hover:bg-muted/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="text-xs">{executorSelectorLabel}</span>
                    <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {availableExecutors.map((executor) => {
                    const isActive =
                      sessionExecutorSelection?.executor === executor;
                    return (
                      <DropdownMenuItem
                        key={executor}
                        onClick={() => handleExecutorSelect(executor)}
                        className="flex items-center justify-between gap-3 text-[11px]"
                      >
                        <span>
                          {executorLabels[executor] ??
                            executor.replace(/_/g, " ")}
                        </span>
                        {isActive ? <Check className="h-3.5 w-3.5" /> : null}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCreateTaskOnly}
                disabled={!hasContent}
                className="rounded-[4px] border border-border px-3 py-1.5 text-[12px] font-medium text-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Create task
              </button>
              <TooltipProvider delayDuration={120}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="submit"
                      disabled={!hasContent}
                      className="rounded-[4px] bg-primary px-4 py-1.5 text-[12px] font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Run task
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    align="end"
                    className="flex items-center gap-1 text-[11px]"
                  >
                    <Command className="h-3.5 w-3.5" />
                    <span className="text-[11px] font-medium">+</span>
                    <span>Enter</span>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>

          {/* Worktree + Branch selector — always visible */}
          <div className="h-px bg-border -mx-0" />
          <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
            <div className="flex items-center gap-4">
              {isGitRepository ? (
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <DropdownMenu modal={false}>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground"
                          >
                            <Laptop className="h-3 w-3" />
                            <span>{useWorktree ? "Worktree" : "Local"}</span>
                            <ChevronDown className="h-2.5 w-2.5" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-[11px]">
                        Worktree isolates changes, Local edits in place
                      </TooltipContent>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem
                          onClick={() => setUseWorktree(true)}
                          className="flex items-center justify-between gap-3 text-[11px]"
                        >
                          <span>Worktree</span>
                          {useWorktree ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : null}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setUseWorktree(false)}
                          className="flex items-center justify-between gap-3 text-[11px]"
                        >
                          <span>Local</span>
                          {!useWorktree ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : null}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Laptop className="h-3 w-3" />
                  <span>Local</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {!isGitRepository ? null : (
                <TooltipProvider delayDuration={120}>
                  <Tooltip>
                    <DropdownMenu
                      modal={false}
                      onOpenChange={(next) => {
                        if (!next) setBaseBranchSearch("");
                      }}
                    >
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger
                          asChild
                          disabled={
                            isLoadingBaseBranches ||
                            baseBranchCandidates.length === 0
                          }
                        >
                          <button
                            type="button"
                            className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-50"
                          >
                            <GitBranch className="h-3 w-3" />
                            <span>From</span>
                            <span className="max-w-[120px] truncate">
                              {isLoadingBaseBranches
                                ? "..."
                                : baseBranch ?? "main"}
                            </span>
                            <ChevronDown className="h-2.5 w-2.5" />
                          </button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-[11px]">
                        Base branch to start working from
                      </TooltipContent>
                      <DropdownMenuContent align="end" className="w-64">
                        <div className="p-2">
                          <div className="relative">
                            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                            <input
                              type="text"
                              placeholder="Search branches..."
                              value={baseBranchSearch}
                              onChange={(e) =>
                                setBaseBranchSearch(e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  return;
                                }
                                e.stopPropagation();
                              }}
                              className="w-full rounded-sm border border-border bg-background py-1.5 pl-7 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                            />
                          </div>
                        </div>
                        <DropdownMenuSeparator />
                        <div className="max-h-48 overflow-y-auto">
                          {filteredBaseBranches.length === 0 ? (
                            <div className="p-2 text-center text-[11px] text-muted-foreground">
                              No branches found
                            </div>
                          ) : (
                            filteredBaseBranches.map((branch) => (
                              <DropdownMenuItem
                                key={branch.name}
                                onClick={() => setBaseBranch(branch.name)}
                                className="flex items-center justify-between gap-3 text-[11px]"
                              >
                                <span className="min-w-0 truncate">
                                  {branch.name}
                                </span>
                                <div className="flex flex-shrink-0 items-center gap-1">
                                  {branch.is_current && (
                                    <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                                      current
                                    </span>
                                  )}
                                  {baseBranch === branch.name && (
                                    <Check className="h-3.5 w-3.5" />
                                  )}
                                </div>
                              </DropdownMenuItem>
                            ))
                          )}
                        </div>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );

  if (variant === "modal") {
    return createPortal(
      <>
        <div
          className="fixed inset-0 z-30 bg-black/20 animate-in fade-in duration-75"
          onClick={handleClose}
          onKeyDown={(e) => {
            if (e.key === "Escape") handleClose();
          }}
          role="presentation"
        />
        <div className="fixed inset-0 z-30 flex items-start justify-center px-4 pt-[20vh] pointer-events-none">
          <div className="pointer-events-auto">{panelContent}</div>
        </div>
      </>,
      document.body,
    );
  }

  return panelContent;
};

// ---------------------------------------------------------------------------
// FilePopoverWithResults — wraps FilePopover and exposes results for keyboard
// ---------------------------------------------------------------------------

interface FilePopoverWithResultsProps {
  open: boolean;
  query: string;
  projectId: string | null;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (path: string, isFile: boolean) => void;
  resultsRef: React.MutableRefObject<{ results: ProjectSearchResult[] }>;
}

const FilePopoverWithResults: React.FC<FilePopoverWithResultsProps> = ({
  resultsRef,
  ...props
}) => {
  const [results, setResults] = useState<ProjectSearchResult[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState(props.query);
  const requestIdRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedQuery(props.query),
      AT_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [props.query]);

  useEffect(() => {
    const id = ++requestIdRef.current;
    if (!props.projectId || !debouncedQuery) {
      setResults([]);
      props.onActiveIndexChange(0);
      return;
    }
    searchProjectFiles(props.projectId, debouncedQuery)
      .then((res) => {
        if (id !== requestIdRef.current) return;
        setResults(res);
        props.onActiveIndexChange(0);
      })
      .catch(() => {
        if (id !== requestIdRef.current) return;
        setResults([]);
        props.onActiveIndexChange(0);
      });
  }, [props.projectId, debouncedQuery]);

  // Expose results to parent for keyboard selection
  useEffect(() => {
    resultsRef.current.results = results;
  }, [results, resultsRef]);

  useEffect(() => {
    if (!listRef.current) return;
    const active = listRef.current.children[props.activeIndex] as
      | HTMLElement
      | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [props.activeIndex]);

  if (!props.open) return null;

  return (
    <div
      className="absolute top-full left-0 z-50 mt-1 w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
      onMouseDown={(e) => e.preventDefault()}
    >
      <div ref={listRef} className="max-h-[280px] overflow-y-auto p-1">
        {results.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted-foreground">
            {debouncedQuery ? "No results found" : "Type to search files"}
          </div>
        ) : (
          results.map((item, index) => {
            const fileName = item.path.split("/").pop() ?? item.path;
            const dirPath = item.path.slice(
              0,
              item.path.length - fileName.length,
            );
            return (
              <button
                key={item.path}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  index === props.activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  props.onSelect(item.path, item.is_file);
                }}
                onMouseEnter={() => props.onActiveIndexChange(index)}
              >
                {item.is_file ? (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {dirPath && (
                    <span className="text-muted-foreground">{dirPath}</span>
                  )}
                  <span className="font-medium">{fileName}</span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
};
