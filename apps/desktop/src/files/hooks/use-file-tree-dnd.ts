
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FileNode } from "../types/file-tree";
import { FileNodeType } from "../types/file-tree";

const DRAG_THRESHOLD_PX = 5;
const PROMPT_EDITOR_DROP_SELECTOR = "[data-prompt-editor-drop]";
const PROMPT_EDITOR_DROP_ACTIVE_ATTR = "data-prompt-editor-drop-active";

interface DraggedNodeInfo {
  path: string;
  name: string;
  isDir: boolean;
}

interface DragState {
  isDragging: boolean;
  draggedNode: DraggedNodeInfo | null;
  dropTargetPath: string | null;
  dropTargetIsDir: boolean;
  isOverPromptEditor: boolean;
  mousePosition: { x: number; y: number };
}

const initialDragState: DragState = {
  isDragging: false,
  draggedNode: null,
  dropTargetPath: null,
  dropTargetIsDir: false,
  isOverPromptEditor: false,
  mousePosition: { x: 0, y: 0 },
};

interface PromptEditorDropPayload {
  node: DraggedNodeInfo;
  clientX: number;
  clientY: number;
  target: HTMLElement;
}

interface UseFileTreeDndOptions {
  rootPath: string | null;
  onMove: (sourcePath: string, targetParentPath: string) => Promise<void>;
  onDropToPromptEditor?: (payload: PromptEditorDropPayload) => void;
}

interface UseFileTreeDndReturn {
  dragState: DragState;
  handlers: {
    onMouseDown: (e: React.MouseEvent, node: FileNode) => void;
  };
  previewPortal: React.ReactNode;
}

export function useFileTreeDnd({
  rootPath,
  onMove,
  onDropToPromptEditor,
}: UseFileTreeDndOptions): UseFileTreeDndReturn {
  const [dragState, setDragState] = useState<DragState>(initialDragState);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const mouseDownRef = useRef<{
    x: number;
    y: number;
    node: FileNode;
  } | null>(null);

  // Create/remove drag preview element
  useEffect(() => {
    if (dragState.isDragging && dragState.draggedNode && !dragPreviewRef.current) {
      const preview = document.createElement("div");
      preview.style.cssText = `
        position: fixed;
        pointer-events: none;
        z-index: 9999;
        opacity: 0.95;
        padding: 4px 10px;
        background-color: var(--custom-sidebar-background-100, #1e1e1e);
        border: 1px solid var(--custom-primary-100, #3b82f6);
        border-radius: 4px;
        font-size: 12px;
        font-family: var(--font-workspace, monospace);
        color: var(--custom-sidebar-text-100, #fff);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
        white-space: nowrap;
      `;
      preview.textContent = dragState.draggedNode.name;
      document.body.appendChild(preview);
      dragPreviewRef.current = preview;
    }

    return () => {
      if (dragPreviewRef.current) {
        document.body.removeChild(dragPreviewRef.current);
        dragPreviewRef.current = null;
      }
    };
  }, [dragState.isDragging, dragState.draggedNode]);

  // Update preview position
  useEffect(() => {
    if (dragPreviewRef.current) {
      dragPreviewRef.current.style.left = `${dragState.mousePosition.x + 12}px`;
      dragPreviewRef.current.style.top = `${dragState.mousePosition.y - 8}px`;
    }
  }, [dragState.mousePosition]);

  // Prevent text selection during drag
  useEffect(() => {
    if (!dragState.isDragging) return;

    // Add user-select: none to body during drag
    const originalUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    return () => {
      document.body.style.userSelect = originalUserSelect;
    };
  }, [dragState.isDragging]);

  // Toggle a hint attribute on the prompt editor while dragging over it
  useEffect(() => {
    if (typeof document === "undefined") return;
    const editors = document.querySelectorAll<HTMLElement>(
      PROMPT_EDITOR_DROP_SELECTOR,
    );
    for (const el of Array.from(editors)) {
      if (dragState.isOverPromptEditor) {
        el.setAttribute(PROMPT_EDITOR_DROP_ACTIVE_ATTR, "true");
      } else {
        el.removeAttribute(PROMPT_EDITOR_DROP_ACTIVE_ATTR);
      }
    }
    return () => {
      for (const el of Array.from(editors)) {
        el.removeAttribute(PROMPT_EDITOR_DROP_ACTIVE_ATTR);
      }
    };
  }, [dragState.isOverPromptEditor]);

  // Global mouse events during drag
  useEffect(() => {
    if (!dragState.isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      setDragState((prev: DragState) => ({
        ...prev,
        mousePosition: { x: e.clientX, y: e.clientY },
      }));

      // Detect drop target using elementFromPoint
      const elementUnder = document.elementFromPoint(e.clientX, e.clientY);
      const promptEditor = elementUnder?.closest(
        PROMPT_EDITOR_DROP_SELECTOR,
      ) as HTMLElement | null;
      const fileTreeItem = elementUnder?.closest("[data-file-path]");
      const fileTreeContainer = elementUnder?.closest("[data-file-tree-root]");

      if (promptEditor) {
        setDragState((prev: DragState) => ({
          ...prev,
          dropTargetPath: null,
          dropTargetIsDir: false,
          isOverPromptEditor: true,
        }));
      } else if (fileTreeItem) {
        const path = fileTreeItem.getAttribute("data-file-path");
        const isDir = fileTreeItem.getAttribute("data-is-dir") === "true";

        if (path && path !== dragState.draggedNode?.path) {
          // Prevent dropping into self or descendants
          const isDropIntoSelf =
            dragState.draggedNode?.isDir &&
            path.startsWith(`${dragState.draggedNode.path}/`);

          setDragState((prev: DragState) => ({
            ...prev,
            dropTargetPath: isDropIntoSelf ? null : path,
            dropTargetIsDir: isDropIntoSelf ? false : isDir,
            isOverPromptEditor: false,
          }));
        } else {
          setDragState((prev: DragState) => ({
            ...prev,
            dropTargetPath: null,
            dropTargetIsDir: false,
            isOverPromptEditor: false,
          }));
        }
      } else if (fileTreeContainer) {
        // Dropped on empty area -> root
        setDragState((prev: DragState) => ({
          ...prev,
          dropTargetPath: "__ROOT__",
          dropTargetIsDir: true,
          isOverPromptEditor: false,
        }));
      } else {
        setDragState((prev: DragState) => ({
          ...prev,
          dropTargetPath: null,
          dropTargetIsDir: false,
          isOverPromptEditor: false,
        }));
      }
    };

    const handleMouseUp = async (e: MouseEvent) => {
      if (
        dragState.isOverPromptEditor &&
        dragState.draggedNode &&
        onDropToPromptEditor
      ) {
        const elementUnder = document.elementFromPoint(e.clientX, e.clientY);
        const promptEditor = elementUnder?.closest(
          PROMPT_EDITOR_DROP_SELECTOR,
        ) as HTMLElement | null;
        if (promptEditor) {
          try {
            onDropToPromptEditor({
              node: dragState.draggedNode,
              clientX: e.clientX,
              clientY: e.clientY,
              target: promptEditor,
            });
          } catch (error) {
            console.error(
              "[use-file-tree-dnd] onDropToPromptEditor failed:",
              error,
            );
          }
        }
        setDragState(initialDragState);
        mouseDownRef.current = null;
        return;
      }

      if (dragState.dropTargetPath && dragState.draggedNode) {
        const { path: sourcePath, name: sourceName } = dragState.draggedNode;
        let targetParentPath = dragState.dropTargetPath;

        // Handle root drop
        if (targetParentPath === "__ROOT__") {
          targetParentPath = rootPath ?? "/";
        }

        // If dropped on a file (not directory), use its parent
        if (!dragState.dropTargetIsDir && targetParentPath !== "__ROOT__") {
          const pathParts = targetParentPath.split("/");
          pathParts.pop();
          targetParentPath = pathParts.join("/") || "/";
        }

        // Compute new path
        const newPath =
          targetParentPath === "/" || targetParentPath === ""
            ? `/${sourceName}`
            : `${targetParentPath}/${sourceName}`;

        // Prevent moving to same location
        if (newPath !== sourcePath) {
          try {
            await onMove(sourcePath, targetParentPath);
          } catch (error) {
            console.error("[use-file-tree-dnd] Move failed:", error);
          }
        }
      }

      // Reset state
      setDragState(initialDragState);
      mouseDownRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("mouseleave", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("mouseleave", handleMouseUp);
    };
  }, [dragState, onMove, onDropToPromptEditor, rootPath]);

  // Track mouse down for drag initiation
  useEffect(() => {
    if (dragState.isDragging) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!mouseDownRef.current) return;

      const dx = e.clientX - mouseDownRef.current.x;
      const dy = e.clientY - mouseDownRef.current.y;
      const distance = Math.hypot(dx, dy);

      if (distance > DRAG_THRESHOLD_PX) {
        const node = mouseDownRef.current.node;
        setDragState({
          isDragging: true,
          draggedNode: {
            path: node.path,
            name: node.name,
            isDir: node.type === FileNodeType.Directory,
          },
          dropTargetPath: null,
          dropTargetIsDir: false,
          isOverPromptEditor: false,
          mousePosition: { x: e.clientX, y: e.clientY },
        });
      }
    };

    const handleGlobalMouseUp = () => {
      mouseDownRef.current = null;
    };

    document.addEventListener("mousemove", handleGlobalMouseMove);
    document.addEventListener("mouseup", handleGlobalMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleGlobalMouseMove);
      document.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [dragState.isDragging]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, node: FileNode) => {
      // Only left click
      if (e.button !== 0) return;

      // Prevent text selection during drag
      e.preventDefault();

      mouseDownRef.current = {
        x: e.clientX,
        y: e.clientY,
        node,
      };
    },
    [],
  );

  return {
    dragState,
    handlers: {
      onMouseDown: handleMouseDown,
    },
    previewPortal: null, // Preview is handled via DOM manipulation
  };
}
