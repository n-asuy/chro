
import { useId } from "react";
import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

export type KanbanColumnIconVariant =
  | "semi"
  | "outline"
  | "dotted"
  | "check"
  | "cross";

interface KanbanColumnIconProps extends ComponentPropsWithoutRef<"svg"> {
  variant?: KanbanColumnIconVariant;
}

export const KanbanColumnIcon = ({
  variant = "outline",
  className,
  ...props
}: KanbanColumnIconProps) => {
  const reactId = useId();
  const maskId = `kanban-column-icon-${reactId.replace(/:/g, "")}`;
  const isSemi = variant === "semi";
  const isDotted = variant === "dotted";
  const isCheck = variant === "check";
  const isCross = variant === "cross";

  return (
    <svg
      viewBox="0 0 24 24"
      role={props["aria-label"] ? "img" : "presentation"}
      aria-hidden={props["aria-label"] ? undefined : true}
      focusable="false"
      className={cn("h-5 w-5 text-custom-text-300", className)}
      {...props}
    >
      {isSemi && (
        <>
          <defs>
            <clipPath id={maskId}>
              <circle cx="12" cy="12" r="7.25" />
            </clipPath>
          </defs>
          <rect
            x="12"
            y="4.75"
            width="7.25"
            height="14.5"
            clipPath={`url(#${maskId})`}
            fill="currentColor"
            opacity={0.28}
          />
        </>
      )}
      <circle
        cx="12"
        cy="12"
        r="7.25"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={isDotted ? "2.6 2.6" : undefined}
        strokeLinecap={isDotted ? "round" : "butt"}
      />
      {isCheck && (
        <path
          d="M8.8 12.6l2.3 2.1 4.1-4.1"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.65}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {isCross && (
        <>
          <path
            d="M9 9l6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.65}
            strokeLinecap="round"
          />
          <path
            d="M15 9l-6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.65}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
};
