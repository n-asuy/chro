import { cn } from "@/lib/cn";
import type { Dispatch, ReactElement, SetStateAction } from "react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

interface ResizableSidebarProps {
  showPeek?: boolean;
  togglePeek: (value?: boolean) => void;
  isCollapsed?: boolean;
  width: number;
  setWidth: Dispatch<SetStateAction<number>>;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  defaultCollapsed?: boolean;
  peekDuration?: number;
  toggleCollapsed: (value?: boolean) => void;
  onWidthChange?: (width: number) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
  className?: string;
  children?: ReactElement;
  extendedSidebar?: ReactElement;
  isAnyExtendedSidebarExpanded?: boolean;
  isAnySidebarDropdownOpen?: boolean;
  disablePeekTrigger?: boolean;
  sidebarClassName?: string;
  side?: "left" | "right";
}

export function ResizableSidebar({
  showPeek = false,
  togglePeek,
  peekDuration = 500,
  isCollapsed = false,
  toggleCollapsed: toggleCollapsedProp,
  onCollapsedChange,
  width,
  setWidth,
  onWidthChange,
  minWidth = 236,
  maxWidth = 350,
  className = "",
  children,
  extendedSidebar,
  isAnyExtendedSidebarExpanded = false,
  isAnySidebarDropdownOpen = false,
  disablePeekTrigger = false,
  sidebarClassName = "",
  side = "left",
}: ResizableSidebarProps) {
  const isRight = side === "right";
  const [isResizing, setIsResizing] = useState(false);
  const [isHoveringTrigger, setIsHoveringTrigger] = useState(false);
  const peekTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const initialWidthRef = useRef<number>(0);
  const initialMouseXRef = useRef<number>(0);

  const setShowPeek = useCallback(
    (value: boolean) => {
      togglePeek(value);
    },
    [togglePeek],
  );

  const handleResize = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      const deltaX = e.clientX - initialMouseXRef.current;
      // For right sidebar, invert the delta (dragging left increases width)
      const adjustedDelta = isRight ? -deltaX : deltaX;
      const newWidth = Math.min(
        Math.max(initialWidthRef.current + adjustedDelta, minWidth),
        maxWidth,
      );
      setWidth(newWidth);
    },
    [isResizing, minWidth, maxWidth, setWidth, isRight],
  );

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      setIsResizing(true);
      initialWidthRef.current = width;
      initialMouseXRef.current = e.clientX;
    },
    [width],
  );

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const toggleCollapsed = useCallback(() => {
    toggleCollapsedProp();
    setShowPeek(false);
    setIsHoveringTrigger(false);
    if (peekTimeoutRef.current) {
      clearTimeout(peekTimeoutRef.current);
    }
  }, [toggleCollapsedProp, setShowPeek]);

  const handleTriggerEnter = useCallback(() => {
    if (isCollapsed) {
      setIsHoveringTrigger(true);
      setShowPeek(true);
      if (peekTimeoutRef.current) {
        clearTimeout(peekTimeoutRef.current);
      }
    }
  }, [isCollapsed, setShowPeek]);

  const handleTriggerLeave = useCallback(() => {
    if (isCollapsed && !isAnyExtendedSidebarExpanded) {
      setIsHoveringTrigger(false);
      peekTimeoutRef.current = setTimeout(() => {
        setShowPeek(false);
      }, peekDuration);
    }
  }, [isCollapsed, peekDuration, setShowPeek, isAnyExtendedSidebarExpanded]);

  const handlePeekEnter = useCallback(() => {
    if (isCollapsed && showPeek) {
      if (peekTimeoutRef.current) {
        clearTimeout(peekTimeoutRef.current);
      }
    }
  }, [isCollapsed, showPeek]);

  const handlePeekLeave = useCallback(() => {
    if (
      isCollapsed &&
      !isAnyExtendedSidebarExpanded &&
      !isAnySidebarDropdownOpen
    ) {
      peekTimeoutRef.current = setTimeout(() => {
        setShowPeek(false);
      }, peekDuration);
    }
  }, [
    isCollapsed,
    peekDuration,
    setShowPeek,
    isAnyExtendedSidebarExpanded,
    isAnySidebarDropdownOpen,
  ]);

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

  useEffect(
    () => () => {
      if (peekTimeoutRef.current) {
        clearTimeout(peekTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!isAnySidebarDropdownOpen && isCollapsed && isHoveringTrigger) {
      handlePeekLeave();
    }
  }, [
    isAnySidebarDropdownOpen,
    isCollapsed,
    isHoveringTrigger,
    handlePeekLeave,
  ]);

  useEffect(() => {
    if (!isAnyExtendedSidebarExpanded && isCollapsed && isHoveringTrigger) {
      handlePeekLeave();
    }
  }, [
    isAnyExtendedSidebarExpanded,
    isCollapsed,
    isHoveringTrigger,
    handlePeekLeave,
  ]);

  useEffect(() => {
    if (!isCollapsed) {
      setShowPeek(false);
      setIsHoveringTrigger(false);
      if (peekTimeoutRef.current) {
        clearTimeout(peekTimeoutRef.current);
      }
    }
  }, [isCollapsed, setShowPeek]);

  useEffect(() => {
    onWidthChange?.(width);
  }, [width, onWidthChange]);

  useEffect(() => {
    onCollapsedChange?.(isCollapsed ?? false);
  }, [isCollapsed, onCollapsedChange]);

  return (
    <>
      <div
        className={cn(
          "h-full z-20 bg-custom-background-100",
          !isCollapsed &&
            (isRight
              ? "border-l border-custom-sidebar-border-200"
              : "border-r border-custom-sidebar-border-200"),
          isCollapsed && "border-transparent",
          isCollapsed
            ? isRight
              ? "translate-x-[100%] opacity-0 w-0"
              : "translate-x-[-100%] opacity-0 w-0"
            : "translate-x-0 opacity-100",
          className,
        )}
        style={{
          width: `${isCollapsed ? 0 : width}px`,
          minWidth: `${isCollapsed ? 0 : width}px`,
          maxWidth: `${isCollapsed ? 0 : width}px`,
        }}
        role="complementary"
        aria-label={isRight ? "Right sidebar" : "Main sidebar"}
      >
        <aside
          className={cn(
            "group/sidebar h-full w-full bg-custom-sidebar-background-90 overflow-hidden relative flex flex-col",
            sidebarClassName,
          )}
        >
          {children}

          <div
            className={cn(
              "transition-colors duration-150 ease-out cursor-ew-resize absolute h-full w-0.5 z-[20]",
              // transparent ::before widens the grab zone past the 2px line
              "before:absolute before:inset-y-0 before:-inset-x-[3px] before:content-['']",
              !isResizing && "hover:bg-primary/70",
              isResizing && "bg-primary/70",
              "top-0",
              isRight ? "left-0" : "right-0",
            )}
            onDoubleClick={() => toggleCollapsed()}
            onMouseDown={(e) => startResizing(e)}
            role="separator"
            aria-label="Resize sidebar"
          />
        </aside>
      </div>

      {isCollapsed && !disablePeekTrigger && (
        <div
          className={cn(
            "absolute top-0 w-1 h-full z-50 bg-transparent",
            isRight ? "right-0" : "left-0",
            isHoveringTrigger ? "opacity-100" : "opacity-0",
          )}
          onMouseEnter={handleTriggerEnter}
          onMouseLeave={handleTriggerLeave}
          role="button"
          aria-label="Show sidebar peek"
        />
      )}

      {isCollapsed ? (
        <div
          className={cn(
            "absolute z-20 bg-custom-background-100 shadow-sm h-full",
            isRight ? "right-0" : "left-0",
            showPeek
              ? "translate-x-0 opacity-100"
              : isRight
                ? "translate-x-[100%] opacity-0"
                : "translate-x-[-100%] opacity-0",
            "pointer-events-none",
            showPeek && "pointer-events-auto",
          )}
          style={{
            width: `${showPeek ? width : 0}px`,
          }}
          onMouseEnter={handlePeekEnter}
          onMouseLeave={handlePeekLeave}
          role="complementary"
          aria-label="Sidebar peek view"
        >
          <aside
            className={cn(
              "group/sidebar h-full w-full bg-custom-sidebar-background-90 overflow-hidden relative flex flex-col z-20 pt-4",
              isRight
                ? "border-l border-custom-sidebar-border-200"
                : "border-r border-custom-sidebar-border-200",
              sidebarClassName,
            )}
          >
            {children}
            <div
              className={cn(
                "transition-colors duration-150 ease-out cursor-ew-resize absolute h-full w-0.5 z-[20]",
                "before:absolute before:inset-y-0 before:-inset-x-[3px] before:content-['']",
                !isResizing && "hover:bg-primary/70",
                isResizing && "bg-primary/70",
                "top-0",
                isRight ? "left-0" : "right-0",
              )}
              onDoubleClick={() => toggleCollapsed()}
              onMouseDown={(e) => startResizing(e)}
              role="separator"
              aria-label="Resize sidebar"
            />
          </aside>
        </div>
      ) : null}

      {extendedSidebar && extendedSidebar}
    </>
  );
}
