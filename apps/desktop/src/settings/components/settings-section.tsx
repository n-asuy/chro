import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type SettingsSectionProps = {
  heading?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function SettingsSection({
  heading,
  description,
  action,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {heading || action ? (
        <div className="flex items-start justify-between gap-4 px-0.5">
          {heading ? (
            <div className="flex flex-col gap-0.5">
              <h3 className="font-workspace text-[14px] font-semibold text-foreground">
                {heading}
              </h3>
              {description ? (
                <p className="font-workspace text-[12px] text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
          ) : (
            <div />
          )}
          {action ? (
            <div className="flex shrink-0 items-center">{action}</div>
          ) : null}
        </div>
      ) : null}
      <div className="divide-y divide-border/30 rounded-2xl border border-border/30 bg-card overflow-hidden">
        {children}
      </div>
    </div>
  );
}
