"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { getClient, getAccessToken, setAccessToken, refreshAccessToken } from "../lib/client";
import { setApiKey, signOut, clearAll } from "../lib/client-auth";
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
    // ADR-037 D-2 — hydrate the in-memory access token from the httpOnly refresh
    // cookie (the access token is lost on reload; the cookie is the durable
    // credential). No cookie ⇒ refresh fails ⇒ /api/auth/me 401 ⇒ not authed.
    if (!getAccessToken()) {
      await refreshAccessToken();
    }

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
      if (status === 401 || status === 403) {
        // No valid session cookie — sign out cleanly.
        clearAll();
        clearDashboardQueries();
        setIsAuthenticated(false);
        setUser(null);
      } else {
        // Network/timeout is transient — let individual pages surface a retry.
        console.error("Failed to fetch user:", err);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (jwt: string, apiKey?: string, rememberMe = false, refreshToken?: string) => {
    setIsLoading(true);
    clearDashboardQueries();
    // ADR-037 D1 — the access token lives in memory; the server set the
    // br_refresh + br_csrf cookies on the login response. The API key is legacy
    // (D-3 removes it). rememberMe/refreshToken are no longer stored client-side.
    void rememberMe;
    void refreshToken;
    setAccessToken(jwt);
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
    // ADR-037 D5 — one-time cookie migration: abandon any legacy localStorage
    // access/refresh tokens (the session is a cookie now). This signs out a
    // pre-cutover session so it re-authenticates into the cookie flow, and stops
    // the old script-readable values being an XSS target on return.
    try {
      if (typeof window !== "undefined" && !localStorage.getItem("brainrouter_cookie_migrated_v1")) {
        localStorage.removeItem("brainrouter_jwt");
        localStorage.removeItem("brainrouter_refresh");
        localStorage.setItem("brainrouter_cookie_migrated_v1", "1");
      }
    } catch { /* ignore */ }
    fetchUser();
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated, isAdmin: user?.isAdmin ?? false, refreshUser: fetchUser, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
