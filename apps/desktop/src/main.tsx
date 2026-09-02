import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { capture, identify, initAnalytics } from "./lib/analytics";
import { loadUiState } from "./lib/ui-state-client";
import { routeTree } from "./routeTree.gen";
import { RootErrorBoundary, RouteErrorBoundary } from "./system/error-boundary";
import "./app/globals.css";

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  // Replace TanStack Router's bare default error screen with a recoverable
  // fallback so a render error in any route (editor crashes, runaway setState
  // loops) no longer leaves the user stuck on a dead full-screen error.
  defaultErrorComponent: RouteErrorBoundary,
});

const queryClient = new QueryClient();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Load persisted UI state and analytics config from backend
loadUiState().catch(() => {});

// Resolve feature flags at startup so `useFlag` reads real values, then keep
// them fresh: this window may stay open for days, and a flag flipped remotely
// (e.g. a kill switch) has to reach it without a restart.
import("./lib/feature-flags-store").then(async ({ useFeatureFlagStore }) => {
  await useFeatureFlagStore.getState().load();
  const { startFlagRefresh } = await import("./lib/flag-refresh");
  startFlagRefresh({
    refresh: () => void useFeatureFlagStore.getState().load(),
  });
});

import("./lib/preferences-client").then(({ fetchPreferences }) =>
  fetchPreferences()
    .then((res) => {
      initAnalytics({ enabled: res.preferences.analytics_enabled });
      identify(res.preferences.telemetry_id);
      capture("app_opened");
    })
    .catch(() => {
      initAnalytics({ enabled: false });
    }),
);

// Local activity recording: instruments the UI at the document level and
// Console access to feature flags (`chroFlags.force(...)`), dev builds only.
if (import.meta.env.DEV) {
  void import("./lib/flags-dev-console");
}

// flushes to a JSONL file on this machine. Dev builds only, and nothing it
// records is transmitted.
if (import.meta.env.DEV || __DEV_EVENTS_FORCED__) {
  void Promise.all([
    import("./lib/dev-events"),
    import("./lib/dev-autocapture"),
  ]).then(([{ startDevEventFlushing }, { installDevAutocapture }]) => {
    startDevEventFlushing();
    installDevAutocapture({ router });
  });
}

if (__PERF_ENABLED__) {
  import("./perf/recorder").then(
    ({ startPerfRecording, observeRouteTransitions }) => {
      startPerfRecording();
      observeRouteTransitions(router);
    },
  );
}

const rootElement = document.getElementById("root");
if (rootElement && !rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <StrictMode>
      <RootErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </RootErrorBoundary>
    </StrictMode>,
  );
}
