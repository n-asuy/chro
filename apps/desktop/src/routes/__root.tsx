import { isEdgeSurface } from "@/edge-toolbar/edge-surface";
import { EdgeToolbarHost } from "@/edge-toolbar/edge-toolbar-host";
import { LanguageProvider } from "@/i18n";
import { OnboardingFlow } from "@/onboarding/onboarding-flow";
import { SettingsModalProvider } from "@/settings/components/settings-modal-provider";
import { useAppViewRequests } from "@/settings/hooks/use-app-view-requests";
import { useSessionActivation } from "@/settings/hooks/use-session-activation";
import { useTaskCompletionNotifications } from "@/settings/hooks/use-task-completion-notifications";
import { useTheme } from "@/settings/hooks/use-theme";
import { ExternalLinkHandler } from "@/system/external-link-handler";
import { NavigationHandler } from "@/system/navigation-handler";
import { useSelectAllMenuShortcut } from "@/system/use-select-all-menu-shortcut";
import { Toaster } from "@chro/ui/toaster";
import {
  Outlet,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import { useLayoutEffect } from "react";

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * Side-effect-only component: drives desktop notifications for background task
 * completions. Rendered inside LanguageProvider so notification copy localizes.
 */
function TaskCompletionNotifier(): null {
  useTaskCompletionNotifications();
  return null;
}

/** The chro theme the edge window is drawn on (see `EdgeRootLayout`). */
const EDGE_THEME = "dark";

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return isEdgeSurface(pathname) ? <EdgeRootLayout /> : <AppRootLayout />;
}

/**
 * The edge toolbar window: a transparent surface with only the providers its
 * components need. App-wide effects (notifications, onboarding, navigation
 * handlers) run in the session windows, once.
 *
 * Its palette is fixed and ignores the appearance setting: the document is
 * pinned to the dark theme, and `edge-toolbar.css` re-points the theme tokens
 * for the edge surface.
 */
function EdgeRootLayout() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.surface = "edge";
    root.dataset.theme = EDGE_THEME;
  }, []);
  return (
    <div className="font-sans antialiased" data-theme={EDGE_THEME}>
      <LanguageProvider>
        <Outlet />
      </LanguageProvider>
    </div>
  );
}

/** Opens Settings or Feedback when the edge toolbar asks for them. */
function AppViewRequests() {
  useAppViewRequests();
  return null;
}

function AppRootLayout() {
  const { dataTheme } = useTheme();
  useSelectAllMenuShortcut();
  useSessionActivation();

  return (
    <div className="font-sans antialiased" data-theme={dataTheme}>
      <ExternalLinkHandler />
      <NavigationHandler />
      <EdgeToolbarHost />
      <LanguageProvider>
        <TaskCompletionNotifier />
        <SettingsModalProvider>
          <AppViewRequests />
          <Outlet />
        </SettingsModalProvider>
        <OnboardingFlow />
      </LanguageProvider>
      <Toaster viewportClassName="bottom-4 right-4 top-auto left-auto w-auto items-end p-3" />
    </div>
  );
}
