import { LanguageProvider } from "@/i18n";
import { OnboardingFlow } from "@/onboarding/onboarding-flow";
import { SettingsModalProvider } from "@/settings/components/settings-modal-provider";
import { useNotificationActivation } from "@/settings/hooks/use-notification-activation";
import { useTaskCompletionNotifications } from "@/settings/hooks/use-task-completion-notifications";
import { useTheme } from "@/settings/hooks/use-theme";
import { ExternalLinkHandler } from "@/system/external-link-handler";
import { NavigationHandler } from "@/system/navigation-handler";
import { useSelectAllMenuShortcut } from "@/system/use-select-all-menu-shortcut";
import { Toaster } from "@chro/ui/toaster";
import { Outlet, createRootRoute } from "@tanstack/react-router";

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

function RootLayout() {
  const { dataTheme } = useTheme();
  useSelectAllMenuShortcut();
  useNotificationActivation();

  return (
    <div className="font-sans antialiased" data-theme={dataTheme}>
      <ExternalLinkHandler />
      <NavigationHandler />
      <LanguageProvider>
        <TaskCompletionNotifier />
        <SettingsModalProvider>
          <Outlet />
        </SettingsModalProvider>
        <OnboardingFlow />
      </LanguageProvider>
      <Toaster
        viewportClassName="bottom-4 right-4 top-auto left-auto w-auto items-end p-3"
        toastClassName="mx-0 max-w-sm bg-black px-3 py-2 text-xs text-white border-black/80 shadow-md [&_[toast-close]]:text-white/60 [&_[toast-close]]:hover:text-white"
      />
    </div>
  );
}
