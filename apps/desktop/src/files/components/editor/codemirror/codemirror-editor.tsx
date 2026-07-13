/**
 * CodeMirror 6 WYSIWYG Editor React Component
 * Replaces the Muya editor with a CodeMirror 6 based WYSIWYG markdown editor
 */

import {
  history,
  historyKeymap,
  indentWithTab,
  redo,
  standardKeymap,
  undo,
} from "@codemirror/commands";
import {
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import type {
  LanguageDescription,
  LanguageSupport,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import {
  SearchQuery,
  closeSearchPanel,
  findNext as cmFindNext,
  findPrevious as cmFindPrevious,
  getSearchQuery,
  openSearchPanel,
  search,
  setSearchQuery,
} from "@codemirror/search";
import {
  Compartment,
  EditorState,
  type Extension,
  StateEffect,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  type ReactNode,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { startPerfTimer } from "@/perf/recorder";
import { useEditorConfigStore } from "@/settings/state/editor-config-store";
import {
  BubbleMenu,
  type BubbleMenuPlacement,
  bubbleMenuExtension,
} from "./plugins/bubble-menu";
import type { EmbedPluginConfig } from "./plugins/prose";
import { type WysiwygConfig, createWysiwygPlugin } from "./wysiwyg";

export interface CodeMirrorEditorHandle {
  undo: () => void;
  redo: () => void;
  getContent: () => string;
  setContent: (content: string) => void;
  focus: () => void;
  setSearchQuery: (query: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearSearch: () => void;
  /** Scroll a 1-based line to the center of the viewport and place the cursor there. */
  scrollToLine: (line: number) => void;
}

interface CodeMirrorEditorProps {
  /** Content key to identify the file - when this changes, editor resets to initialContent */
  contentKey: string;
  /** Initial markdown content */
  initialContent: string;
  /** Callback when content changes */
  onChange?: (markdown: string) => void;
  /** Additional CSS class names */
  className?: string;
  /** Whether the editor is disabled/read-only */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /**
   * Editor mode: "prose" for WYSIWYG markdown, "code" for plain code with line numbers.
   * Defaults to "prose".
   */
  mode?: "prose" | "code";
  /**
   * File extension (without dot) for code mode syntax highlighting.
   * e.g. "ts", "sh", "json"
   */
  fileExtension?: string;
  /**
   * Render prop for bubble menu content.
   * Receives the EditorView instance to allow formatting commands.
   * If not provided, no menu is shown.
   */
  renderBubbleMenu?: (view: EditorView | null) => ReactNode;
  /** Bubble menu placement preference */
  bubbleMenuPlacement?: BubbleMenuPlacement;
  /** Callback when an internal link is clicked (Ctrl/Cmd+Click) */
  onInternalLinkClick?: (path: string) => void;
  /** Configuration for embed rendering */
  embedConfig?: EmbedPluginConfig;
  /** Callback when an embed is clicked */
  onEmbedClick?: (path: string, type: string) => void;
  /**
   * Called when the user presses Mod+F inside the editor. Lets the host
   * render its own find UI instead of CodeMirror's default panel.
   */
  onFindRequest?: () => void;
}

/**
 * Load a language for code blocks
 */
const LANGUAGE_OVERRIDES: Record<string, string> = {
  webvtt: "plain text",
};

const findLanguageDescription = (
  info: string,
): LanguageDescription | undefined => {
  if (!info) return undefined;
  const normalized = info.toLowerCase();
  const target = LANGUAGE_OVERRIDES[normalized] ?? normalized;

  return languages.find((language) => {
    if (language.name.toLowerCase() === target) {
      return true;
    }
    return (
      language.alias?.some((alias) => alias.toLowerCase() === target) ?? false
    );
  });
};

async function loadLanguage(info: string): Promise<LanguageSupport> {
  const matchedLanguage = findLanguageDescription(info);
  if (matchedLanguage) {
    return await matchedLanguage.load();
  }

  const fallbackLanguage = findLanguageDescription("plain text");
  if (fallbackLanguage) {
    console.warn(
      `[codemirror] Language "${info}" not found. Falling back to Plain Text.`,
    );
    return await fallbackLanguage.load();
  }

  console.warn(
    `[codemirror] Language "${info}" not found. Falling back to Markdown.`,
  );
  const { markdown } = await import("@codemirror/lang-markdown");
  return markdown();
}

const DEFAULT_EDITOR_FONT_FAMILY =
  'var(--font-inter), "Inter", system-ui, -apple-system, sans-serif';
const DEFAULT_EDITOR_LINE_WRAPPING = true;
const DEFAULT_EDITOR_TAB_SIZE = 4;
const DEFAULT_EDITOR_INDENT_WITH_SPACES = true;
const DEFAULT_EDITOR_SHOW_LINE_NUMBERS = false;

const refreshDecorationsEffect = StateEffect.define<void>();

export const CodeMirrorEditor = forwardRef<
  CodeMirrorEditorHandle,
  CodeMirrorEditorProps
>(function CodeMirrorEditor(
  {
    contentKey,
    initialContent,
    onChange,
    className = "",
    disabled = false,
    placeholder,
    mode = "prose",
    fileExtension,
    renderBubbleMenu,
    bubbleMenuPlacement = "top",
    onInternalLinkClick,
    embedConfig,
    onEmbedClick,
    onFindRequest,
  },
  ref,
) {
  const onFindRequestRef = useRef(onFindRequest);
  useEffect(() => {
    onFindRequestRef.current = onFindRequest;
  }, [onFindRequest]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const contentKeyRef = useRef(contentKey);
  const compartments = useRef({
    editable: new Compartment(),
    fontSize: new Compartment(),
  });
  const [view, setView] = useState<EditorView | null>(null);
  const editorConfig = useEditorConfigStore((s) => s.config);
  const loadEditorConfig = useEditorConfigStore((s) => s.load);

  // Load editor config from backend on first mount
  useEffect(() => {
    void loadEditorConfig();
  }, [loadEditorConfig]);

  // Keep onChange ref up to date
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Expose imperative handle
  useImperativeHandle(ref, () => ({
    undo: () => {
      if (viewRef.current) {
        undo(viewRef.current);
      }
    },
    redo: () => {
      if (viewRef.current) {
        redo(viewRef.current);
      }
    },
    getContent: () => {
      return viewRef.current?.state.doc.toString() ?? "";
    },
    setContent: (content: string) => {
      if (viewRef.current) {
        viewRef.current.dispatch({
          changes: {
            from: 0,
            to: viewRef.current.state.doc.length,
            insert: content,
          },
        });
      }
    },
    focus: () => {
      viewRef.current?.focus();
    },
    setSearchQuery: (query: string) => {
      const view = viewRef.current;
      if (!view) return;
      const current = getSearchQuery(view.state);
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            search: query,
            caseSensitive: current.caseSensitive,
            regexp: current.regexp,
            wholeWord: current.wholeWord,
            replace: current.replace,
            literal: current.literal,
          }),
        ),
      });
      // CodeMirror only paints match highlights while its search panel is
      // considered open. The panel itself renders an empty, hidden element
      // (see the search() config below); our own find bar is the visible UI.
      openSearchPanel(view);
    },
    findNext: () => {
      const view = viewRef.current;
      if (view) cmFindNext(view);
    },
    findPrevious: () => {
      const view = viewRef.current;
      if (view) cmFindPrevious(view);
    },
    clearSearch: () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "" })),
      });
      closeSearchPanel(view);
    },
    scrollToLine: (line: number) => {
      const view = viewRef.current;
      if (!view) return;
      const clamped = Math.max(1, Math.min(line, view.state.doc.lines));
      const info = view.state.doc.line(clamped);
      view.dispatch({
        selection: { anchor: info.from },
        effects: EditorView.scrollIntoView(info.from, { y: "center" }),
      });
      view.focus();
    },
  }));

  // Create the update listener
  const createUpdateListener = useCallback(() => {
    return EditorView.updateListener.of((update) => {
      if (update.docChanged && onChangeRef.current) {
        onChangeRef.current(update.state.doc.toString());
      }
    });
  }, []);

  // Initialize editor
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const finishInitTimer = startPerfTimer("editor_mount", {
      content_key: contentKey,
      initial_chars: initialContent.length,
    });
    let initTimerCompleted = false;

    // Read initial editor config
    const initialConfig = useEditorConfigStore.getState().config;

    const isCodeMode = mode === "code";
    const codeFontFamily =
      'var(--font-mono, "JetBrains Mono", "Fira Code", "SF Mono", Menlo, monospace)';

    // Build extensions
    const extensions: Extension[] = [
      DEFAULT_EDITOR_LINE_WRAPPING ? EditorView.lineWrapping : [],
      compartments.current.fontSize.of(
        EditorView.theme({
          ".cm-content": {
            fontSize: `${isCodeMode ? initialConfig.font_size - 1 : initialConfig.font_size}px`,
            lineHeight: String(initialConfig.line_height),
            fontFamily: isCodeMode ? codeFontFamily : DEFAULT_EDITOR_FONT_FAMILY,
          },
          ".cm-gutters": {
            fontSize: `${isCodeMode ? initialConfig.font_size - 1 : initialConfig.font_size}px`,
          },
        }),
      ),
      EditorState.tabSize.of(DEFAULT_EDITOR_TAB_SIZE),
      indentUnit.of(
        DEFAULT_EDITOR_INDENT_WITH_SPACES
          ? " ".repeat(DEFAULT_EDITOR_TAB_SIZE)
          : "\t",
      ),

      // Line numbers: always on for code mode, configurable for prose mode
      isCodeMode || DEFAULT_EDITOR_SHOW_LINE_NUMBERS ? lineNumbers() : [],

      // Basic editor features
      history(),
      rectangularSelection(),
      indentOnInput(),
      foldGutter(),

      // Syntax highlighting
      syntaxHighlighting(defaultHighlightStyle),

      // Search extension powers match highlighting and the query state. We
      // suppress its built-in panel and instead let the host (files-editor)
      // render an Obsidian-style find bar above the document.
      search({ createPanel: () => ({ dom: document.createElement("div") }) }),
      // Intercept Mod-f so it doesn't escape to the browser's native find.
      // Delegate to the host so the find bar appears outside the CodeMirror
      // editor (above title / frontmatter).
      keymap.of([
        {
          key: "Mod-f",
          preventDefault: true,
          run: () => {
            onFindRequestRef.current?.();
            return true;
          },
        },
      ]),
      keymap.of([...standardKeymap, ...historyKeymap, indentWithTab]),

      // Editable state (via compartment for dynamic updates)
      compartments.current.editable.of(EditorView.editable.of(!disabled)),

      // Change listener
      createUpdateListener(),
    ];

    if (isCodeMode) {
      // Code mode: load language-specific syntax highlighting, no WYSIWYG
      const langName = fileExtension ?? "plain text";
      loadLanguage(langName).then((langSupport) => {
        if (viewRef.current) {
          viewRef.current.dispatch({
            effects: StateEffect.appendConfig.of(langSupport),
          });
        }
      });
    } else {
      // Prose mode: WYSIWYG markdown editing
      const wysiwygConfig: WysiwygConfig = {
        lezer: {
          codeLanguages: loadLanguage,
        },
      };

      if (onInternalLinkClick) {
        wysiwygConfig.onInternalLinkClick = onInternalLinkClick;
      }

      if (embedConfig) {
        wysiwygConfig.embeds = embedConfig;
        wysiwygConfig.markdownImages = {
          resolveUrl: embedConfig.getImageUrl,
        };
      }

      if (onEmbedClick) {
        wysiwygConfig.onEmbedClick = onEmbedClick;
      }

      const wysiwygPlugin = createWysiwygPlugin(wysiwygConfig);
      extensions.push(wysiwygPlugin);

      // Bubble menu extension (only for prose mode)
      extensions.push(bubbleMenuExtension());
    }

    // Add placeholder if provided
    if (placeholder) {
      extensions.push(
        EditorView.contentAttributes.of({ "aria-placeholder": placeholder }),
      );
    }

    // Create editor state
    const state = EditorState.create({
      doc: initialContent,
      extensions,
    });

    // Create editor view
    const view = new EditorView({
      state,
      parent: element,
    });

    viewRef.current = view;
    setView(view);
    requestAnimationFrame(() => {
      if (viewRef.current === view) {
        view.dispatch({ effects: refreshDecorationsEffect.of(undefined) });
        finishInitTimer({
          outcome: "ok",
          rendered_chars: view.state.doc.length,
        });
        initTimerCompleted = true;
      }
    });

    return () => {
      if (!initTimerCompleted) {
        finishInitTimer({ outcome: "disposed_before_render" });
        initTimerCompleted = true;
      }
      view.destroy();
      viewRef.current = null;
      setView(null);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update editable state when disabled changes
  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.dispatch({
        effects: compartments.current.editable.reconfigure(
          EditorView.editable.of(!disabled),
        ),
      });
    }
  }, [disabled]);

  // Reconfigure editor when editorConfig changes
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;

    v.dispatch({
      effects: [
        compartments.current.fontSize.reconfigure(
          EditorView.theme({
            ".cm-content": {
              fontSize: `${editorConfig.font_size}px`,
              lineHeight: String(editorConfig.line_height),
              fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
            },
            ".cm-gutters": {
              fontSize: `${editorConfig.font_size}px`,
            },
          }),
        ),
      ],
    });
  }, [editorConfig]);

  // Reset content when contentKey changes
  useEffect(() => {
    if (contentKeyRef.current === contentKey) {
      return;
    }

    const previousContentKey = contentKeyRef.current;
    contentKeyRef.current = contentKey;
    const finishResetTimer = startPerfTimer("editor_content_reset", {
      from_content_key: previousContentKey,
      to_content_key: contentKey,
      initial_chars: initialContent.length,
    });

    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: viewRef.current.state.doc.length,
          insert: initialContent,
        },
      });
      requestAnimationFrame(() => {
        if (viewRef.current) {
          viewRef.current.dispatch({
            effects: refreshDecorationsEffect.of(undefined),
          });
          finishResetTimer({
            outcome: "ok",
            rendered_chars: viewRef.current.state.doc.length,
          });
        } else {
          finishResetTimer({ outcome: "view_disposed_before_render" });
        }
      });
    } else {
      finishResetTimer({ outcome: "skipped_no_view" });
    }
  }, [contentKey, initialContent]);

  const bubbleMenuContent = renderBubbleMenu?.(view);

  return (
    <>
      <div
        ref={containerRef}
        className={`cm-editor-container ${mode === "code" ? "cm-code-mode" : ""} ${className}`}
      />
      {bubbleMenuContent && (
        <BubbleMenu view={view} placement={bubbleMenuPlacement}>
          {bubbleMenuContent}
        </BubbleMenu>
      )}
    </>
  );
});
