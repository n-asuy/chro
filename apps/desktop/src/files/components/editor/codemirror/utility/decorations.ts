import { Decoration, WidgetType } from "@codemirror/view";

/**
 * Decoration to hide markdown syntax tokens (e.g., **, __, ``, etc.)
 */
export const decorationHidden = Decoration.replace({
  class: "cm-obsidian-hidden cm-obsidian",
  tagName: "span",
});

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-obsidian-bullet cm-obsidian";
    span.textContent = "•";
    return span;
  }
}

/**
 * Decoration for bullet list markers — replaces `-` with `•`
 */
export const decorationBullet = Decoration.replace({
  widget: new BulletWidget(),
});

/**
 * Decoration for hashtags (#tag)
 */
export const decorationProseHashtag = Decoration.mark({
  class: "cm-hashtag",
  tagName: "span",
});

