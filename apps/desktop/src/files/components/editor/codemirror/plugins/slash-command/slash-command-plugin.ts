/**
 * Slash command plugin for CodeMirror 6
 * Provides autocomplete-style command palette triggered by "/"
 */

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  autocompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { filterCommands, slashCommands } from "./slash-commands";

/**
 * Check if the cursor is at a position where slash commands should trigger
 * (at the start of a line or after whitespace)
 */
function shouldTriggerSlashCommand(context: CompletionContext): boolean {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const textBefore = line.text.slice(0, pos - line.from);

  // Find the last "/" in the line
  const slashIndex = textBefore.lastIndexOf("/");
  if (slashIndex === -1) return false;

  // Check if "/" is at the start of line or after whitespace
  if (slashIndex === 0) return true;
  const charBeforeSlash = textBefore[slashIndex - 1];
  return /\s/.test(charBeforeSlash);
}

/**
 * Get the query string after the slash
 */
function getSlashQuery(
  context: CompletionContext,
): { from: number; query: string } | null {
  const { state, pos } = context;
  const line = state.doc.lineAt(pos);
  const textBefore = line.text.slice(0, pos - line.from);

  const slashIndex = textBefore.lastIndexOf("/");
  if (slashIndex === -1) return null;

  // Verify it's a valid slash command position
  if (slashIndex > 0 && !/\s/.test(textBefore[slashIndex - 1])) {
    return null;
  }

  const query = textBefore.slice(slashIndex + 1);
  return {
    from: line.from + slashIndex,
    query,
  };
}

/**
 * Slash command completion source
 */
function slashCommandCompletions(
  context: CompletionContext,
): CompletionResult | null {
  if (!shouldTriggerSlashCommand(context)) return null;

  const queryInfo = getSlashQuery(context);
  if (!queryInfo) return null;

  const { from, query } = queryInfo;
  const matchingCommands = filterCommands(query);

  if (matchingCommands.length === 0) return null;

  const options: Completion[] = matchingCommands.map((cmd) => ({
    label: `/${cmd.id}`,
    displayLabel: cmd.label,
    detail: cmd.description,
    type: "keyword",
    boost: cmd.id.startsWith(query) ? 10 : 0,
    apply: (view: EditorView) => {
      cmd.execute(view);
    },
  }));

  return {
    from,
    options,
    filter: false, // We handle filtering ourselves
  };
}

/**
 * Create the slash command extension
 */
export function createSlashCommandPlugin(): Extension {
  return autocompletion({
    override: [slashCommandCompletions],
    defaultKeymap: true,
    icons: false,
    optionClass: () => "cm-slash-command-option",
    addToOptions: [
      {
        render: (completion: Completion) => {
          const container = document.createElement("div");
          container.className = "cm-slash-command-item";

          const icon = document.createElement("span");
          icon.className = "cm-slash-command-icon";
          icon.textContent = getIconForCommand(completion.label);

          const content = document.createElement("div");
          content.className = "cm-slash-command-content";

          const label = document.createElement("span");
          label.className = "cm-slash-command-label";
          label.textContent = completion.displayLabel ?? completion.label;

          const detail = document.createElement("span");
          detail.className = "cm-slash-command-detail";
          detail.textContent = completion.detail ?? "";

          content.appendChild(label);
          content.appendChild(detail);

          container.appendChild(icon);
          container.appendChild(content);

          return container;
        },
        position: 10,
      },
    ],
  });
}

/**
 * Get icon text for a command
 */
function getIconForCommand(label: string): string {
  const iconMap: Record<string, string> = {
    "/h1": "#",
    "/h2": "##",
    "/h3": "###",
    "/h4": "####",
    "/h5": "#####",
    "/h6": "######",
    "/list": "-",
    "/numbered": "1.",
    "/task": "[]",
    "/quote": ">",
    "/callout": ">!",
    "/code": "```",
    "/table": "||",
    "/math": "$$",
    "/mermaid": "```",
    "/hr": "---",
    "/link": "[]",
    "/image": "![]",
    "/wikilink": "[[",
    "/embed": "![[",
  };
  return iconMap[label] ?? "/";
}

/**
 * CSS styles for slash command menu
 */
export const slashCommandStyles = `
  .cm-tooltip-autocomplete {
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 8px;
    background: var(--bg-primary, #ffffff);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    min-width: 280px;
  }

  .cm-tooltip-autocomplete > ul {
    max-height: 300px;
    overflow-y: auto;
    padding: 4px;
  }

  .cm-tooltip-autocomplete > ul > li {
    padding: 0;
    margin: 0;
    border-radius: 6px;
  }

  .cm-tooltip-autocomplete > ul > li[aria-selected="true"] {
    background: var(--bg-hover, #f0f0f0);
  }

  .cm-slash-command-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    cursor: pointer;
  }

  .cm-slash-command-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    background: var(--bg-secondary, #f5f5f5);
    font-size: 14px;
    flex-shrink: 0;
  }

  .cm-slash-command-content {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .cm-slash-command-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary, #1a1a1a);
  }

  .cm-slash-command-detail {
    font-size: 12px;
    color: var(--text-secondary, #666666);
  }

  /* Hide default completion styling */
  .cm-slash-command-option .cm-completionLabel,
  .cm-slash-command-option .cm-completionDetail,
  .cm-slash-command-option .cm-completionIcon {
    display: none;
  }
`;

export { slashCommands, filterCommands } from "./slash-commands";
