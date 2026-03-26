import { Link } from "@tanstack/react-router";
import type { ReactNode, MouseEvent } from "react";
import { cn } from "@/lib/cn";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@chro/ui/tooltip";

type AppSidebarItemLayout = "stacked" | "compact";

type AppSidebarItemProps = {
  label?: string;
  icon?: ReactNode;
  href?: string;
  isActive?: boolean;
  onClick?: (event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) => void;
  variant?: "link" | "button";
  className?: string;
  layout?: AppSidebarItemLayout;
  badge?: number;
};

export const AppSidebarItem = ({
  label,
  icon,
  href,
  isActive = false,
  onClick,
  variant = "link",
  className,
  layout = "stacked",
  badge,
}: AppSidebarItemProps) => {
  const isCompact = layout === "compact";
  const showLabel = !isCompact && Boolean(label);
  const showTooltip = isCompact && Boolean(label);
  const ariaLabel = isCompact ? label : undefined;

  const itemClassName = cn(
    "flex items-center rounded-[3px] cursor-pointer group relative outline-none select-none",
    isCompact ? "justify-center w-10 h-10 mx-auto" : "w-full px-3 py-2 gap-3",
    isActive
      ? "text-custom-sidebar-text-100"
      : "text-custom-sidebar-text-200 hover:bg-custom-sidebar-background-90 hover:text-custom-sidebar-text-100",
    className,
  );

  const showBadge = typeof badge === "number" && badge > 0;

  const content = (
    <>
      <div
        className={cn(
          "flex items-center justify-center shrink-0 relative",
        )}
      >
        {icon}
        {showBadge && isCompact && (
          <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-custom-primary-100 px-0.5 text-[9px] font-bold leading-none text-white">
            {badge}
          </span>
        )}
      </div>
      {showLabel && (
        <span className="text-[13px] font-medium whitespace-nowrap overflow-hidden text-left flex-1">
          {label}
        </span>
      )}
      {showBadge && !isCompact && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-custom-primary-100 px-1 text-[10px] font-bold leading-none text-white shrink-0">
          {badge}
        </span>
      )}
    </>
  );

  const element =
    variant === "button" || !href ? (
      <button
        type="button"
        onClick={onClick}
        className={itemClassName}
        aria-label={ariaLabel}
        aria-current={isActive ? "page" : undefined}
        title={isCompact ? label : undefined}
      >
        {content}
      </button>
    ) : (
      <Link
        to={href}
        onClick={onClick}
        className={itemClassName}
        aria-label={ariaLabel}
        aria-current={isActive ? "page" : undefined}
        title={isCompact ? label : undefined}
      >
        {content}
      </Link>
    );

  if (!showTooltip) {
    return element;
  }

  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>{element}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export type { AppSidebarItemProps };
