
import type { ReactNode } from "react";

type SidebarWrapperProps = {
  title?: string;
  quickActions?: ReactNode;
  children: ReactNode;
  headerBorder?: boolean;
};

export const SidebarWrapper = ({
  title,
  quickActions,
  children,
  headerBorder = true,
}: SidebarWrapperProps) => {
  const showHeader = Boolean(title) || Boolean(quickActions);
  const headerClasses = ["flex flex-col gap-2.5 px-4 py-3"];
  if (headerBorder) headerClasses.push("border-b border-custom-border-200");

  return (
    <div className="flex h-full w-full flex-col">
      {showHeader && (
        <div className={headerClasses.join(" ")}>
          {title && (
            <div className="flex items-center justify-between gap-3">
              <span className="font-workspace text-[12px] uppercase tracking-[0.3em] text-custom-text-300">
                {title}
              </span>
            </div>
          )}

          {quickActions && (
            <div className={title ? "pt-0.5" : undefined}>{quickActions}</div>
          )}
        </div>
      )}

      <div className="size-full overflow-x-hidden overflow-y-auto">
        <div className="flex h-full w-full flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 pt-3 pb-1">
          {children}
        </div>
      </div>
    </div>
  );
};
