
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { cn } from "@/lib/cn";

type SidebarSectionProps = {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  actionIcon?: ReactNode;
  actionProps?: ButtonHTMLAttributes<HTMLButtonElement>;
};

export const SidebarSection = ({
  title,
  children,
  defaultOpen = true,
  actionLabel,
  onAction,
  actionIcon = <Plus className="size-3" strokeWidth={2} />,
  actionProps,
}: SidebarSectionProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="flex flex-col">
      <div className="group font-workspace text-[12px] leading-[1.35] w-full flex items-center justify-between px-2 py-1.5 rounded text-custom-sidebar-text-400 hover:bg-custom-sidebar-background-90">
        <button
          type="button"
          className="font-workspace text-[12px] leading-[1.35] w-full flex items-center gap-1 whitespace-nowrap text-left text-custom-sidebar-text-400"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-label={`${isOpen ? "Collapse" : "Expand"} ${title}`}
        >
          <span className="font-workspace text-[12px] leading-[1.35]">
            {title}
          </span>
        </button>
        <div className="flex items-center gap-1 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto">
          {actionLabel && (
            <button
              type="button"
              {...actionProps}
              className={cn(
                "p-0.5 rounded hover:bg-custom-sidebar-background-80 flex-shrink-0",
                actionProps?.className,
              )}
              onClick={(event) => {
                actionProps?.onClick?.(event);
                onAction?.();
              }}
              aria-label={actionLabel}
            >
              {actionIcon}
            </button>
          )}
          <button
            type="button"
            className="p-0.5 rounded hover:bg-custom-sidebar-background-80 flex-shrink-0"
            onClick={() => setIsOpen((prev) => !prev)}
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${title}`}
          >
            <ChevronRight
              className={cn("flex-shrink-0 size-3", {
                "rotate-90": isOpen,
              })}
            />
          </button>
        </div>
      </div>
      {isOpen && <div className="flex flex-col gap-0.5">{children}</div>}
    </div>
  );
};
