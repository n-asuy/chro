"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "../utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

const TooltipTrigger = TooltipPrimitive.Trigger;

interface TooltipContentProps
  extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {
  hideArrow?: boolean;
  arrowClassName?: string;
  container?: HTMLElement | null;
}

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(
  (
    {
      className,
      sideOffset = 6,
      hideArrow = false,
      arrowClassName,
      style,
      container,
      ...props
    },
    ref,
  ) => (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "relative z-50 rounded-[6px] border border-white/20 px-3 py-1 text-[11px] font-medium text-white shadow-none backdrop-blur-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
          className,
        )}
        style={{ backgroundColor: "rgba(0, 0, 0, 0.85)", ...style }}
        {...props}
      >
        {props.children}
        {!hideArrow && (
          <TooltipPrimitive.Arrow
            width={11}
            height={6}
            stroke="rgba(255,255,255,0.25)"
            strokeWidth={0.75}
            fill="rgba(0,0,0,0.85)"
            className={cn("shadow-none", arrowClassName)}
          />
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  ),
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
