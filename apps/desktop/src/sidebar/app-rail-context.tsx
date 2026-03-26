import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { getUiValue, setUiValue } from "@/lib/ui-state-client";

const APP_RAIL_EXPANDED_KEY = "chro-desktop-app-rail-expanded";

type AppRailContextValue = {
  expanded: boolean;
  toggleExpanded: () => void;
  setExpanded: (value: boolean) => void;
};

const AppRailContext = createContext<AppRailContextValue | null>(null);

type AppRailProviderProps = {
  children: ReactNode;
};

export const AppRailProvider = ({ children }: AppRailProviderProps) => {
  const [expanded, setExpandedState] = useState(
    () => getUiValue<boolean>(APP_RAIL_EXPANDED_KEY) ?? true,
  );

  useEffect(() => {
    setUiValue(APP_RAIL_EXPANDED_KEY, expanded);
  }, [expanded]);

  const toggleExpanded = useCallback(() => {
    setExpandedState((prev) => !prev);
  }, []);

  const setExpanded = useCallback((value: boolean) => {
    setExpandedState(value);
  }, []);

  return (
    <AppRailContext.Provider value={{ expanded, toggleExpanded, setExpanded }}>
      {children}
    </AppRailContext.Provider>
  );
};

export const useOptionalAppRail = (): AppRailContextValue | null => {
  return useContext(AppRailContext);
};
