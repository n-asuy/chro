import { useLanguage } from "@/i18n";
import { SettingsPanel } from "@/settings/settings-panel";
import { Dialog, DialogContent, DialogTitle } from "@chro/ui/dialog";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

type SettingsModalContextValue = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
};

const SettingsModalContext = createContext<SettingsModalContextValue | null>(
  null,
);

type SettingsModalProviderProps = {
  children: ReactNode;
};

export function SettingsModalProvider({
  children,
}: SettingsModalProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  const open = useCallback(() => {
    setHasInitialized(true);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const value = useMemo<SettingsModalContextValue>(
    () => ({ isOpen, open, close }),
    [isOpen, open, close],
  );

  return (
    <SettingsModalContext.Provider value={value}>
      {children}
      {hasInitialized ? (
        <SettingsModal isOpen={isOpen} onOpenChange={setIsOpen} />
      ) : null}
    </SettingsModalContext.Provider>
  );
}

type SettingsModalProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Settings modal chrome, sharing the app's single Radix dialog shell (light
 * blurred overlay, soft shadow, built-in close) with every other modal. The
 * panel fills a large, fixed-height content box; its own heading structure
 * stands in for the visually-hidden dialog title kept here for accessibility.
 */
function SettingsModal({ isOpen, onOpenChange }: SettingsModalProps) {
  const { t } = useLanguage();
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] w-[calc(100vw-2rem)] max-w-[1280px] flex-col gap-0 overflow-hidden rounded-md bg-custom-background-100 p-0">
        <DialogTitle className="sr-only">{t("settingsTitle")}</DialogTitle>
        <SettingsPanel variant="modal" className="h-full" />
      </DialogContent>
    </Dialog>
  );
}

export function useSettingsModal() {
  const context = useContext(SettingsModalContext);
  if (!context) {
    throw new Error(
      "useSettingsModal must be used within a SettingsModalProvider",
    );
  }
  return context;
}
