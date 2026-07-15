"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { getClient } from "../lib/client";
import { getRefreshToken, isAuthenticated as checkIsAuthenticated, setJwt, setApiKey, setRefreshToken, signOut, clearAll } from "../lib/client-auth";
import { authFetch } from "../lib/adminApi";
import { STATIC_PRESENTATION } from "../lib/presentation";
import { clearDashboardQueries } from "../lib/dashboardQuery";

interface AuthUser {
  userId: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  refreshUser: () => Promise<void>;
  login: (jwt: string, apiKey?: string, rememberMe?: boolean, refreshToken?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  isAdmin: false,
  refreshUser: async () => {},
  login: async () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const fetchUser = async () => {
    // Presentation mode: never hit the auth API — there is no session.
    if (STATIC_PRESENTATION) {
      setIsAuthenticated(false);
      setUser(null);
      setIsLoading(false);
      return;
    }
    if (!checkIsAuthenticated()) {
      setIsAuthenticated(false);
      setUser(null);
      setIsLoading(false);
      return;
    }

    // A locally valid access/refresh credential is enough to render the shell.
    // Validate and hydrate the profile in the background so a slow or offline
    // account endpoint cannot hide every dashboard page behind a global loader.
    setIsAuthenticated(true);
    setIsLoading(false);

    try {
      const data = await authFetch<AuthUser>("/api/auth/me");
      setUser({
        userId: data.userId,
        displayName: data.displayName,
        email: data.email,
        isAdmin: data.isAdmin,
      });
      setIsAuthenticated(true);
    } catch (err) {
      const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status?: number }).status) : 0;
      if ((status === 401 || status === 403) && (!getRefreshToken() || !checkIsAuthenticated())) {
        clearAll();
        clearDashboardQueries();
        setIsAuthenticated(false);
        setUser(null);
      } else {
        // Network/timeout failures are transient. Keep the locally valid
        // session usable; individual pages surface their own retry state.
        setIsAuthenticated(checkIsAuthenticated());
      }
      console.error("Failed to fetch user:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (jwt: string, apiKey?: string, rememberMe = false, refreshToken?: string) => {
    setIsLoading(true);
    clearDashboardQueries();
    setJwt(jwt, rememberMe);
    if (refreshToken) setRefreshToken(refreshToken);
    if (apiKey) setApiKey(apiKey);
    await fetchUser();
  };

  const logout = () => {
    // Best-effort server revoke, then clear local tokens + redirect.
    try {
      getClient().signOut().catch(() => {});
    } catch {
      /* ignore */
    }
    signOut();
    clearDashboardQueries();
    setUser(null);
    setIsAuthenticated(false);
  };

  useEffect(() => {
    fetchUser();
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated, isAdmin: user?.isAdmin ?? false, refreshUser: fetchUser, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
