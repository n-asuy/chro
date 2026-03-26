
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type SidebarNavItemProps = {
  children: ReactNode;
  className?: string;
  isActive?: boolean;
};

export const SidebarNavItem = ({
  children,
  className,
  isActive,
}: SidebarNavItemProps) => {
  return (
    <div
      className={cn(
        "font-workspace text-[12px] leading-[1.35] cursor-pointer relative group w-full flex items-center justify-between gap-1.5 rounded px-2 py-1 outline-none",
        {
          "text-custom-text-200 bg-custom-background-80/75": isActive,
          "text-custom-sidebar-text-200 hover:bg-custom-sidebar-background-90 active:bg-custom-sidebar-background-90":
            !isActive,
        },
        className,
      )}
    >
      {children}
    </div>
  );
};
