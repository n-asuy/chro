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
  toastClassName?: string;
};

export function Toaster({ viewportClassName, toastClassName }: ToasterProps) {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => (
        <Toast
          key={id}
          {...props}
          className={cn(
            "mx-auto max-w-md items-start",
            toastClassName,
            props.className,
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 pr-5">
            {title && (
              <ToastTitle className="min-w-0 break-words font-medium leading-snug">
                {title}
              </ToastTitle>
            )}
            {description && (
              <ToastDescription className="min-w-0 break-words text-xs leading-snug">
                {description}
              </ToastDescription>
            )}
          </div>
          {action ? <div className="mr-5 shrink-0">{action}</div> : null}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport className={viewportClassName} />
    </ToastProvider>
  );
}
