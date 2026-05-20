"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { getClient } from "../lib/client";
import { isAuthenticated as checkIsAuthenticated, setJwt, setApiKey, signOut } from "../lib/client-auth";

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
  refreshUser: () => Promise<void>;
  login: (jwt: string, apiKey?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
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
    if (!checkIsAuthenticated()) {
      setIsAuthenticated(false);
      setUser(null);
      setIsLoading(false);
      return;
    }

    try {
      const client = getClient();
      const data = await client.me();
      setUser({
        userId: data.userId,
        displayName: data.displayName,
        email: data.email,
        isAdmin: data.isAdmin,
      });
      setIsAuthenticated(true);
    } catch (err) {
      console.error("Failed to fetch user:", err);
      setIsAuthenticated(false);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (jwt: string, apiKey?: string) => {
    setIsLoading(true);
    setJwt(jwt);
    if (apiKey) setApiKey(apiKey);
    await fetchUser();
  };

  const logout = () => {
    signOut();
    setUser(null);
    setIsAuthenticated(false);
  };

  useEffect(() => {
    fetchUser();
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated, refreshUser: fetchUser, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
