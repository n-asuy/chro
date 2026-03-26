import { LanguageProvider } from "@/i18n";
import { GlobalSearchProvider } from "@/search/global-search-provider";
import { SettingsModalProvider } from "@/settings/components/settings-modal-provider";
import { useTheme } from "@/settings/hooks/use-theme";
import { ExternalLinkHandler } from "@/system/external-link-handler";
import { NavigationHandler } from "@/system/navigation-handler";
import { UpdateInstallPopup } from "@/system/update-install-popup";
import { Toaster } from "@chro/ui/toaster";
import { Outlet, createRootRoute } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const { dataTheme } = useTheme();
  return (
    <div className="font-sans antialiased" data-theme={dataTheme}>
      <ExternalLinkHandler />
      <NavigationHandler />
      <LanguageProvider>
        <UpdateInstallPopup />
        <SettingsModalProvider>
          <GlobalSearchProvider>
            <Outlet />
          </GlobalSearchProvider>
        </SettingsModalProvider>
      </LanguageProvider>
      <Toaster
        viewportClassName="bottom-4 right-4 top-auto left-auto w-auto items-end p-3"
        toastClassName="mx-0 max-w-xs bg-black px-3 py-1.5 text-xs text-white border-black/80 shadow-md [&_[toast-close]]:text-white/60 [&_[toast-close]]:hover:text-white"
      />
    </div>
  );
}
