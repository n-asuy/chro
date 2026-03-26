/**
 * WYSIWYG editor configuration
 * Combines all plugins into a cohesive rich text editing experience
 */

import { ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { closeBrackets } from "@codemirror/autocomplete";
import type { LanguageSupport } from "@codemirror/language";

import { RichEditPlugin } from "./plugins/rich-text-plugin";
import { syntaxHighlightStyles } from "./plugins/syntax-highlight-plugin";
import { customOFMParsers } from "./lezer-parsers";

// Prose plugins
import {
  hashtagPlugin,
  highlightPlugin,
  quoteblockPlugin,
  taskListPlugin,
  editorLivePreviewField,
  internalLinkPlugin,
  externalLinkPlugin,
  calloutPlugin,
  mermaidPlugin,
  mathPlugin,
  createTablePlugin,
  htmlPlugin,
  codeblockPlugin,
  createEmbedPlugin,
  createInternalLinkClickHandler,
  createExternalLinkClickHandler,
  createEmbedClickHandler,
  createMarkdownImagePlugin,
  createYouTubeEmbedPlugin,
  type EmbedPluginConfig,
  type MarkdownImagePluginConfig,
} from "./plugins/prose";

// Editor plugins
import { keymapPlugin } from "./plugins/editor";

// Slash command plugin
import { createSlashCommandPlugin } from "./plugins/slash-command";

/**
 * Configuration for the WYSIWYG plugin
 */
export interface WysiwygConfig {
  /**
   * Lezer parser configuration
   */
  lezer?: {
    /**
     * Function to load code block languages
     */
    codeLanguages?: (info: string) => Promise<LanguageSupport>;
    /**
     * Additional parser extensions
     */
    extensions?: unknown[];
  };
  /**
   * Embed plugin configuration
   */
  embeds?: EmbedPluginConfig;
  /**
   * Markdown image plugin configuration
   */
  markdownImages?: MarkdownImagePluginConfig;
  /**
   * Callback when an internal link is clicked
   */
  onInternalLinkClick?: (path: string) => void;
  /**
   * Callback when an embed is clicked
   */
  onEmbedClick?: (path: string, type: string) => void;
}

/**
 * Creates a WYSIWYG editor plugin with all decorations and behaviors
 */
export function createWysiwygPlugin(config?: WysiwygConfig) {
  const { codeLanguages, ...lezerRest } = config?.lezer ?? {};

  const mergedConfig = {
    ...(lezerRest ?? {}),
    codeLanguages: codeLanguages,
    extensions: [
      GFM,
      ...customOFMParsers,
      { remove: ["SetextHeading"] },
      ...(config?.lezer?.extensions ?? []),
    ],
    nested: {
      blockquote: true,
      list: true,
    },
  };

  // Build additional extensions based on config
  const additionalExtensions: Extension[] = [];
  const tablePlugin = createTablePlugin({
    onInternalLinkClick: config?.onInternalLinkClick,
  });

  // Add internal link click handler if callback provided
  if (config?.onInternalLinkClick) {
    additionalExtensions.push(
      createInternalLinkClickHandler(config.onInternalLinkClick),
    );
  }

  // Always enable external link click handling
  additionalExtensions.push(createExternalLinkClickHandler());

  // Add embed plugin if config provided
  if (config?.embeds) {
    additionalExtensions.push(createEmbedPlugin(config.embeds));

    if (config.onEmbedClick) {
      additionalExtensions.push(createEmbedClickHandler(config.onEmbedClick));
    }
  }

  // Add markdown image plugin if config provided
  if (config?.markdownImages) {
    additionalExtensions.push(createMarkdownImagePlugin(config.markdownImages));
  }

  return ViewPlugin.fromClass(RichEditPlugin, {
    decorations: (v: RichEditPlugin) => v.decorations,
    provide: () => [
      // Slash command autocomplete and bracket closing
      createSlashCommandPlugin(),
      closeBrackets(),

      // Prose decoration plugins
      highlightPlugin,
      hashtagPlugin,
      quoteblockPlugin,
      taskListPlugin,
      internalLinkPlugin,
      externalLinkPlugin,
      calloutPlugin,
      mermaidPlugin,
      mathPlugin,
      tablePlugin,
      htmlPlugin,
      codeblockPlugin,
      createYouTubeEmbedPlugin(),

      // Editor state field
      editorLivePreviewField,

      // Editor behavior plugins
      keymapPlugin,

      // Syntax highlighting
      syntaxHighlighting(syntaxHighlightStyles),

      // Markdown language support
      // @ts-expect-error - Type mismatch due to different lezer-markdown versions
      markdown(mergedConfig),

      // Additional extensions (click handlers, etc.)
      ...additionalExtensions,
    ],
  });
}

export default createWysiwygPlugin;
