/**
 * Shared Mermaid expanded-view modal.
 *
 * Opens a fullscreen modal that shows a rendered Mermaid SVG with zoom (buttons
 * + wheel) and drag-to-pan. Implemented as plain DOM (no framework) so the exact
 * same behaviour can be triggered from the CodeMirror editor decorations and
 * from the React markdown renderer used in the session view.
 *
 * Styling lives in app/globals.css under the `.cm-mermaid-modal*` selectors,
 * which are global (not scoped to the editor), so the modal renders identically
 * wherever it is opened.
 */

// --- Zoom constants (shared between the inline editor controls and the modal) ---

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 5;
export const ZOOM_STEP = 0.25;

// --- Inline SVG icons (vanilla DOM, no React) ---

export const ICON_ZOOM_IN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`;

export const ICON_ZOOM_OUT = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`;

export const ICON_RESET = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;

// Shrink icon (reverse of expand) used to close the modal.
export const ICON_SHRINK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;

/**
 * Open a modal dialog showing the mermaid diagram with floating zoom/pan controls.
 */
export function openExpandedView(svgContent: string): void {
  const backdrop = document.createElement("div");
  backdrop.className = "cm-mermaid-modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "cm-mermaid-modal";

  // Zoom/pan state
  let scale = 1;
  let translateX = 0;
  let translateY = 0;

  const canvas = document.createElement("div");
  canvas.className = "cm-mermaid-modal-canvas";
  canvas.innerHTML = svgContent;

  const applyTransform = () => {
    canvas.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  };

  modal.appendChild(canvas);

  // Floating controls (same style as inline editor controls)
  const controls = document.createElement("div");
  controls.className = "cm-mermaid-modal-controls";

  const createBtn = (icon: string, label: string, onClick: () => void) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-mermaid-control-btn";
    btn.setAttribute("aria-label", label);
    btn.innerHTML = icon;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    btn.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
    return btn;
  };

  controls.appendChild(
    createBtn(ICON_ZOOM_IN, "Zoom in", () => {
      scale = Math.min(scale + ZOOM_STEP, ZOOM_MAX);
      applyTransform();
    }),
  );
  controls.appendChild(
    createBtn(ICON_ZOOM_OUT, "Zoom out", () => {
      scale = Math.max(scale - ZOOM_STEP, ZOOM_MIN);
      applyTransform();
    }),
  );
  controls.appendChild(
    createBtn(ICON_RESET, "Reset zoom", () => {
      scale = 1;
      translateX = 0;
      translateY = 0;
      applyTransform();
    }),
  );
  controls.appendChild(
    createBtn(ICON_SHRINK, "Close expanded view", () => cleanup()),
  );

  modal.appendChild(controls);
  backdrop.appendChild(modal);

  // Drag-to-pan
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  modal.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".cm-mermaid-control-btn")) return;
    isDragging = true;
    dragStartX = e.clientX - translateX;
    dragStartY = e.clientY - translateY;
    modal.style.cursor = "grabbing";
    e.preventDefault();
  });

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    translateX = e.clientX - dragStartX;
    translateY = e.clientY - dragStartY;
    applyTransform();
  };

  const handleMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    modal.style.cursor = "";
  };

  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);

  // Wheel zoom
  modal.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      scale = Math.min(Math.max(scale + delta, ZOOM_MIN), ZOOM_MAX);
      applyTransform();
    },
    { passive: false },
  );

  const cleanup = () => {
    backdrop.remove();
    document.removeEventListener("keydown", handleKeyDown);
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  };

  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) {
      cleanup();
    }
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      cleanup();
    }
  };
  document.addEventListener("keydown", handleKeyDown);

  document.body.appendChild(backdrop);
}
