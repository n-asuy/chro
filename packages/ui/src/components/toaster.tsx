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
          className={cn("max-w-md mx-auto", toastClassName, props.className)}
        >
          <div className="flex items-center gap-2 flex-1">
            {title && <ToastTitle className="font-medium">{title}</ToastTitle>}
            {description && (
              <ToastDescription className="text-xs">
                {description}
              </ToastDescription>
            )}
          </div>
          {action}
          <ToastClose />
        </Toast>
      ))}
      <ToastViewport className={viewportClassName} />
    </ToastProvider>
  );
}
