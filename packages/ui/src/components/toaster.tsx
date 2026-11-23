"use client";

import { useToast } from "../hooks/use-toast";
import { cn } from "../utils";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "./toast";

type ToasterProps = {
  viewportClassName?: string;
};

export function Toaster({ viewportClassName }: ToasterProps) {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => (
        <Toast key={id} {...props} className={cn("max-w-sm", props.className)}>
          <div
            className={cn(
              "flex min-w-0 flex-1 flex-col gap-0.5",
              // The trailing element keeps clear of the hover close button.
              !action && "pr-5",
            )}
          >
            {title && (
              <ToastTitle className="min-w-0 break-words leading-snug">
                {title}
              </ToastTitle>
            )}
            {description && (
              <ToastDescription className="min-w-0 break-words leading-snug">
                {description}
              </ToastDescription>
            )}
          </div>
          {action ? <div className="mr-4 shrink-0">{action}</div> : null}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport className={viewportClassName} />
    </ToastProvider>
  );
}
