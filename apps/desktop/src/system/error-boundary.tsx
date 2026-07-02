import { type TranslationFunction, useOptionalLanguage } from "@/i18n";
import enDict from "@/i18n/locales/en";
import type { TranslationDictionary } from "@/i18n/locales/ja";
import { capture } from "@/lib/analytics";
import { Button } from "@chro/ui/button";
import { useRouter } from "@tanstack/react-router";
import { Component, type ErrorInfo, type ReactNode, useState } from "react";

/**
 * Normalize an unknown thrown value into a human-readable message and an
 * optional stack. Kept pure and exported so it can be unit-tested without a
 * DOM renderer.
 */
export function describeError(error: unknown): {
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message || error.name || "Error",
      stack: error.stack,
    };
  }
  if (typeof error === "string" && error.length > 0) {
    return { message: error };
  }
  return { message: "Unknown error" };
}

type FallbackActions = {
  /** Re-mount the boundary's children. May immediately error again. */
  onRetry?: () => void;
  /** Hard reload of the whole window. Always escapes a stuck state. */
  onReload: () => void;
  /** Navigate to a known-safe screen, when a router is available. */
  onGoHome?: () => void;
};

/**
 * Presentational fallback shared by every error boundary in the app. It never
 * calls setState during render, so it cannot itself trigger the render-loop it
 * is meant to recover from. It degrades to English when rendered above the
 * LanguageProvider.
 */
function ErrorFallback({
  error,
  errorCount,
  componentStack,
  onRetry,
  onReload,
  onGoHome,
}: FallbackActions & {
  error: unknown;
  errorCount: number;
  componentStack?: string | null;
}): ReactNode {
  const lang = useOptionalLanguage();
  const t: TranslationFunction =
    lang?.t ?? ((key) => (enDict as TranslationDictionary)[key] ?? key);
  const [copied, setCopied] = useState(false);

  const { message, stack } = describeError(error);
  // The React component stack pinpoints which component threw, which is far
  // more useful than the JS stack for render loops ("Maximum update depth
  // exceeded"). Surface it (and include it in the copied report) when present.
  const details = [stack ?? message, componentStack]
    .filter(Boolean)
    .join("\n\nComponent stack:");

  const copy = (): void => {
    void navigator.clipboard
      ?.writeText(details)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <div
      role="alert"
      className="flex h-full min-h-screen w-full items-center justify-center bg-background p-6 text-foreground"
    >
      <div className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <h1 className="font-semibold text-base">{t("errorBoundaryTitle")}</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          {t("errorBoundaryDescription")}
        </p>
        {errorCount > 1 ? (
          <p className="mt-2 text-destructive text-sm">
            {t("errorBoundaryRecurring")}
          </p>
        ) : null}

        <details className="mt-4">
          <summary className="cursor-pointer select-none text-muted-foreground text-xs">
            {t("errorBoundaryDetails")}
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded border bg-muted p-3 text-[11px] text-muted-foreground leading-relaxed">
            {details}
          </pre>
        </details>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          {onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t("errorBoundaryRetry")}
            </Button>
          ) : null}
          {onGoHome ? (
            <Button size="sm" variant="outline" onClick={onGoHome}>
              {t("errorBoundaryGoHome")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onReload}>
            {t("errorBoundaryReload")}
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={copy}>
            {copied ? t("copied") : t("copyMessage")}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Distinguishes boundary locations in logs/telemetry. */
  label: string;
  /** Provided so the fallback can offer a recovery action. */
  render: (state: {
    error: unknown;
    errorCount: number;
    componentStack: string | null;
    reset: () => void;
  }) => ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
  errorCount: number;
  componentStack: string | null;
}

/**
 * Generic React error boundary. Catches render/commit errors in its subtree
 * (including "Maximum update depth exceeded" from runaway setState loops),
 * unmounts the broken tree, and renders a recoverable fallback instead of
 * letting the error reach the top of the app.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = {
    error: null,
    errorCount: 0,
    componentStack: null,
  };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const { message } = describeError(error);
    this.setState((prev) => ({
      errorCount: prev.errorCount + 1,
      componentStack: info.componentStack ?? null,
    }));
    console.error(
      `[error-boundary:${this.props.label}]`,
      error,
      info.componentStack,
    );
    try {
      capture("error_boundary", { label: this.props.label, message });
    } catch {
      // Telemetry must never mask the original failure.
    }
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: null });
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      return this.props.render({
        error: this.state.error,
        errorCount: this.state.errorCount,
        componentStack: this.state.componentStack,
        reset: this.reset,
      });
    }
    return this.props.children;
  }
}

/**
 * Last-resort boundary for the very top of the tree (above the providers).
 * Only "Reload" is offered because no router/i18n context is guaranteed here.
 */
export function RootErrorBoundary({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <ErrorBoundary
      label="root"
      render={({ error, errorCount, componentStack, reset }) => (
        <ErrorFallback
          error={error}
          errorCount={errorCount}
          componentStack={componentStack}
          onRetry={reset}
          onReload={() => window.location.reload()}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/**
 * Adapter for TanStack Router's `defaultErrorComponent`. Rendered inside the
 * router (and usually the LanguageProvider), so it can offer navigation and
 * localized copy. Replaces the router's bare "Something went wrong / Hide
 * Error" default for every route.
 */
export function RouteErrorBoundary({
  error,
  reset,
  info,
}: {
  error: unknown;
  reset: () => void;
  info?: { componentStack?: string };
}): ReactNode {
  const router = useRouter();
  return (
    <ErrorFallback
      error={error}
      errorCount={1}
      componentStack={info?.componentStack ?? null}
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
      onReload={() => window.location.reload()}
      onGoHome={() => {
        reset();
        void router.navigate({ to: "/" });
      }}
    />
  );
}
