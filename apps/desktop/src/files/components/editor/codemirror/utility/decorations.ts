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


/**
 * Wrap a block widget's visible box in a spacer that carries its vertical
 * gap as padding. The editor measures a block widget by its border box, so
 * outer margins go uncounted and shift every gutter marker and click target
 * below the widget.
 */
export const spacedBlock = (box: HTMLElement): HTMLElement => {
  const spacer = document.createElement("div");
  spacer.className = "cm-block-spacer";
  spacer.appendChild(box);
  return spacer;
};
