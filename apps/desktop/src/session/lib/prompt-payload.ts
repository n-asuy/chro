import type { PreparedPromptPayload } from "../hooks/use-single-session-controller";
import type { PromptEditorHandle } from "../state/prompt-editor-store";
import {
  contextEntriesToRefs,
  formatContextForPrompt,
  formatSkillContextForPrompt,
} from "../types/context";

/** Uploaded images that travel with a prompt. */
export interface PromptImages {
  /** Markdown references prepended to the prompt text. */
  markdown: string;
  ids: string[] | null;
}

/**
 * What a composer sends: the editor's text with its context references,
 * skills and uploaded images folded in. Shared by every composer so a message
 * reaches the agent the same way whichever surface sent it. `null` when there
 * is nothing to send.
 */
export function preparePromptPayload(
  editor: PromptEditorHandle,
  images: PromptImages,
): PreparedPromptPayload | null {
  const contextEntries = editor.getContextEntries();
  const contextPrefix = formatContextForPrompt(contextEntries);
  const skillEntries = editor.getSkillEntries();
  const skillPrefix = formatSkillContextForPrompt(skillEntries);
  const text = editor.getText().trim();
  const prompt = [contextPrefix, skillPrefix, images.markdown, text]
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!prompt) {
    return null;
  }
  return {
    prompt,
    contextRefs: contextEntriesToRefs(contextEntries),
    imageIds: images.ids,
    selectedSkillIds: skillEntries.map((skill) => skill.id),
  };
}
