import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { initAnalytics, identify, capture } from "./lib/analytics";
import { loadUiState } from "./lib/ui-state-client";
import "./app/globals.css";

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

const queryClient = new QueryClient();

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Load persisted UI state and analytics config from backend
loadUiState().catch(() => {});

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
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  );
}
