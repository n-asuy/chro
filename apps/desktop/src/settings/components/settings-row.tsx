import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type SettingsRowProps = {
  title: string;
  description?: string;
  control?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
  className?: string;
};

export function SettingsRow({
  title,
  description,
  control,
  children,
  disabled,
  className,
}: SettingsRowProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 px-5 py-4",
        disabled && "opacity-60 pointer-events-none",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="font-workspace text-[13px] font-medium text-foreground">
            {title}
          </div>
          {description ? (
            <p className="font-workspace text-[12px] text-muted-foreground mt-0.5">
              {description}
            </p>
          ) : null}
        </div>
        {control ? (
          <div className="flex flex-shrink-0 items-center gap-3">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}
