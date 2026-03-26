import { Dialog, Transition } from "@headlessui/react";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { SettingsPanel } from "@/settings/settings-panel";

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
        <SettingsModal isOpen={isOpen} onClose={close} />
      ) : null}
    </SettingsModalContext.Provider>
  );
}

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  return (
    <Transition.Root show={isOpen} as={Fragment} appear>
      <Dialog as="div" className="relative z-[90]" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="duration-75"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="duration-75"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div
            aria-hidden="true"
            className="fixed inset-0 bg-custom-backdrop/70"
            onClick={onClose}
          />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4 text-center sm:p-6">
            <Transition.Child
              as={Fragment}
              enter="duration-75"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="duration-75"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative flex h-[90vh] w-full transform flex-col overflow-hidden rounded-md border border-custom-border-200 bg-custom-background-100/90 text-left shadow-custom-shadow-lg transition-all sm:max-w-[1280px]">
                <SettingsPanel
                  variant="modal"
                  onCloseRequest={onClose}
                  className="h-full"
                />
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
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
