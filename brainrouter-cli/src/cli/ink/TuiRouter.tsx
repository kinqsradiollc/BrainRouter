import React, { createContext, useContext, useState, useCallback } from 'react';

export type TuiRoute = 'home' | 'session' | 'workflow' | 'mcp';

interface TuiRouterContextProps {
  activeRoute: TuiRoute;
  navigate: (route: TuiRoute) => void;
  history: TuiRoute[];
  goBack: () => void;
}

const TuiRouterContext = createContext<TuiRouterContextProps | undefined>(undefined);

export function useTuiRouter() {
  const context = useContext(TuiRouterContext);
  if (!context) {
    throw new Error('useTuiRouter must be used within a TuiRouterProvider');
  }
  return context;
}

interface TuiRouterProviderProps {
  children: React.ReactNode;
  initialRoute?: TuiRoute;
}

export function TuiRouterProvider({ children, initialRoute = 'session' }: TuiRouterProviderProps) {
  const [activeRoute, setActiveRoute] = useState<TuiRoute>(initialRoute);
  const [history, setHistory] = useState<TuiRoute[]>([initialRoute]);

  const navigate = useCallback((route: TuiRoute) => {
    setActiveRoute(route);
    setHistory((prev) => [...prev, route]);
  }, []);

  const goBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.length <= 1) return prev;
      const nextHistory = prev.slice(0, -1);
      const prevRoute = nextHistory[nextHistory.length - 1];
      setActiveRoute(prevRoute);
      return nextHistory;
    });
  }, []);

  return (
    <TuiRouterContext.Provider value={{ activeRoute, navigate, history, goBack }}>
      {children}
    </TuiRouterContext.Provider>
  );
}
