import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type SettingsSectionProps = {
  heading?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function SettingsSection({
  heading,
  action,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {heading || action ? (
        <div className="flex items-center justify-between px-0.5">
          {heading ? (
            <h3 className="font-workspace text-[14px] font-semibold text-foreground">
              {heading}
            </h3>
          ) : (
            <div />
          )}
          {action ? (
            <div className="flex items-center">{action}</div>
          ) : null}
        </div>
      ) : null}
      <div className="divide-y divide-border/30 rounded-2xl border border-border/30 bg-card overflow-hidden">
        {children}
      </div>
    </div>
  );
}
