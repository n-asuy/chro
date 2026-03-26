import * as React from "react";
import { cn } from "../utils";

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "popover"> {
  popover?: "" | "auto" | "manual" | "hint";
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, popover, ...props }, ref) => {
    const validPopover = popover === "hint" ? undefined : popover;
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        ref={ref}
        popover={validPopover}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
