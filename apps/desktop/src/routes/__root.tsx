import { LanguageProvider } from "@/i18n";
import { GlobalSearchProvider } from "@/search/global-search-provider";
import { SettingsModalProvider } from "@/settings/components/settings-modal-provider";
import { useTheme } from "@/settings/hooks/use-theme";
import { ExternalLinkHandler } from "@/system/external-link-handler";
import { NavigationHandler } from "@/system/navigation-handler";
import { UpdateInstallPopup } from "@/system/update-install-popup";
import { Toaster } from "@chro/ui/toaster";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createRootRoute({
  component: RootLayout,
});

const PROGRAMMING_JOKES = [
  "I would tell you a UDP joke, but you might not get it.",
  "There are 10 kinds of people: those who know binary and those who do not.",
  "My code does not have bugs. It develops random features.",
  "I changed a light bulb once. Now I only debug in the dark.",
  "A SQL query walks into a bar, walks up to two tables, and asks: can I join you?",
];

function PixelCat() {
  const [jokeIndex, setJokeIndex] = useState(0);
  const [showBubble, setShowBubble] = useState(true);

  useEffect(() => {
    const bubbleInterval = window.setInterval(() => {
      setShowBubble(true);
      setJokeIndex((current) => {
        let next = current;
        while (next === current) {
          next = Math.floor(Math.random() * PROGRAMMING_JOKES.length);
        }
        return next;
      });

      window.setTimeout(() => {
        setShowBubble(false);
      }, 3800);
    }, 7200);

    const hideTimer = window.setTimeout(() => {
      setShowBubble(false);
    }, 3800);

    return () => {
      window.clearInterval(bubbleInterval);
      window.clearTimeout(hideTimer);
    };
  }, []);

  return (
    <div className="pixel-cat-overlay" aria-hidden="true">
      <div className="pixel-cat-track">
        <div className="pixel-cat-walker">
          <div className={`pixel-cat-bubble ${showBubble ? "is-visible" : ""}`}>
            {PROGRAMMING_JOKES[jokeIndex]}
          </div>
          <div className="pixel-cat">
            <div className="pixel-cat-tail" />
            <div className="pixel-cat-body" />
            <div className="pixel-cat-leg pixel-cat-leg-front" />
            <div className="pixel-cat-leg pixel-cat-leg-back" />
          </div>
        </div>
      </div>
    </div>
  );
}

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
      <PixelCat />
    </div>
  );
}
