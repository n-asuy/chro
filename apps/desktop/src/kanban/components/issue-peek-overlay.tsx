import { Fragment, useCallback, useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Dialog, Transition } from "@headlessui/react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useWorkspaceBoardContext } from "@/kanban/providers";
import { updateTaskTitle } from "@/kanban/state/task-store";
import { cn } from "@/lib/cn";
import { getUiValue, setUiValue } from "@/lib/ui-state-client";
import { PeekHeader, type PeekMode } from "./peek-header";
import { TaskSessionPanel, type DiffActionState } from "./task-session-panel";

const MIN_WIDTH = 400;
const MAX_WIDTH = 1200;
const DEFAULT_WIDTH = 600;
const STORAGE_KEY = "side-peek-width";

export const IssuePeekOverlay = () => {
  const { peekIssueId, setPeekIssue, getIssueById } =
    useWorkspaceBoardContext();
  const issue = getIssueById(peekIssueId);
  useDocumentTitle(issue?.title ?? null);

  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);
  const [peekMode, setPeekMode] = useState<PeekMode>("side-peek");
  const [isSidePeekOpen, setIsSidePeekOpen] = useState(false);
  const [isModalPeekOpen, setIsModalPeekOpen] = useState(false);
  const [diffActions, setDiffActions] = useState<DiffActionState | null>(null);

  const [width, setWidth] = useState(() => {
    const saved = getUiValue<number>(STORAGE_KEY);
    if (saved !== null && !Number.isNaN(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) {
      return saved;
    }
    return DEFAULT_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const initialWidthRef = useRef<number>(0);
  const initialMouseXRef = useRef<number>(0);

  const handleClose = useCallback(
    () => setPeekIssue(undefined),
    [setPeekIssue],
  );

  const handleDiffActionsChange = useCallback(
    (actions: DiffActionState | null) => {
      setDiffActions(actions);
    },
    [],
  );

  const handleTitleChange = useCallback(
    async (newTitle: string) => {
      if (!issue) return;
      await updateTaskTitle(issue.id, newTitle);
    },
    [issue],
  );

  const handleToggleFullScreen = useCallback(() => {
    setPeekMode((prev) => (prev === "full-screen" ? "side-peek" : "full-screen"));
  }, []);

  const handleResize = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      const deltaX = e.clientX - initialMouseXRef.current;
      // Right side panel: dragging left increases width
      const newWidth = Math.min(
        Math.max(initialWidthRef.current - deltaX, MIN_WIDTH),
        MAX_WIDTH,
      );
      setWidth(newWidth);
    },
    [isResizing],
  );

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      initialWidthRef.current = width;
      initialMouseXRef.current = e.clientX;
    },
    [width],
  );

  const stopResizing = useCallback(() => {
    if (isResizing) {
      setIsResizing(false);
      setUiValue(STORAGE_KEY, width);
    }
  }, [isResizing, width]);

  useEffect(() => {
    setPortalElement(document.getElementById("full-screen-portal"));
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener("mousemove", handleResize);
      document.addEventListener("mouseup", stopResizing);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleResize);
      document.removeEventListener("mouseup", stopResizing);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, handleResize, stopResizing]);

  useEffect(() => {
    if (peekIssueId) {
      if (peekMode === "side-peek") {
        setIsSidePeekOpen(true);
        setIsModalPeekOpen(false);
      } else {
        setIsModalPeekOpen(true);
        setIsSidePeekOpen(false);
      }
    } else {
      setIsSidePeekOpen(false);
      setIsModalPeekOpen(false);
    }
  }, [peekIssueId, peekMode]);

  useEffect(() => {
    if (!issue) {
      setDiffActions(null);
    }
  }, [issue]);

  useEffect(() => {
    if (!isSidePeekOpen && !isModalPeekOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (peekMode === "full-screen") {
          setPeekMode("side-peek");
        } else {
          handleClose();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose, isSidePeekOpen, isModalPeekOpen, peekMode]);

  if (!portalElement) return null;

  const sidePeekContent = (
    <div className="flex h-full w-full flex-col overflow-hidden font-workspace text-[12px] leading-[1.35]">
      <PeekHeader
        issue={issue}
        peekMode={peekMode}
        onClose={handleClose}
        onToggleFullScreen={handleToggleFullScreen}
        diffActions={diffActions}
        onTitleChange={handleTitleChange}
      />
      {issue ? (
        <div className="flex-1 overflow-hidden">
          <TaskSessionPanel
            issue={issue}
            peekMode={peekMode}
            onDiffActionsChange={handleDiffActionsChange}
          />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Select a task to see its session
        </div>
      )}
    </div>
  );

  const overlay = (
    <>
      <Transition.Root appear show={isSidePeekOpen} as={Fragment}>
        <div
          role="complementary"
          className={cn(
            "absolute right-0 top-0 z-20 h-full bg-custom-background-100 border-l border-custom-border-200 font-workspace text-[12px] leading-[1.35]",
            !isResizing && "transition-[width] duration-150",
          )}
          style={{ width: `${width}px` }}
        >
          {/* Resize handle */}
          <div
            className={cn(
              "absolute -left-1.5 top-0 h-full w-3 cursor-col-resize z-30 group",
              "flex items-start justify-center",
            )}
            onMouseDown={startResizing}
            role="separator"
            aria-label="Resize side peek"
          >
            <div
              className={cn(
                "h-full w-0.5",
                "group-hover:bg-custom-primary-100",
                isResizing && "bg-custom-primary-100",
              )}
            />
          </div>
          {sidePeekContent}
        </div>
      </Transition.Root>
      <Transition.Root appear show={isModalPeekOpen} as={Fragment}>
        <Dialog as="div" onClose={handleClose}>
          <div className="fixed inset-0 z-30 bg-custom-backdrop bg-opacity-50" />
          <Dialog.Panel>
            <div
              className={`fixed left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-custom-background-100 shadow-custom-shadow-xl font-workspace text-[12px] leading-[1.35] ${
                peekMode === "modal" ? "h-[70%] w-3/5" : "h-[95%] w-[95%]"
              }`}
            >
              {peekMode === "modal" && sidePeekContent}
              {peekMode === "full-screen" && sidePeekContent}
            </div>
          </Dialog.Panel>
        </Dialog>
      </Transition.Root>
    </>
  );

  return createPortal(overlay, portalElement);
};
