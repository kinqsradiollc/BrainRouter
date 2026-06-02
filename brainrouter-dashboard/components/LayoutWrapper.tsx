"use client";

import { useAuth } from "./AuthProvider";
import { Sidebar } from "./Sidebar";
import { PublicHeader } from "./PublicHeader";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { useTheme } from "./ThemeProvider";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const pathname = usePathname();

  const initials = (user?.displayName || user?.email || "U")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Sidebar collapse state with localStorage persistence
  const [isCollapsed, setIsCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("sidebar_collapsed") === "true";
    }
    return false;
  });

  const handleToggleCollapse = () => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar_collapsed", String(next));
      return next;
    });
  };

  if (isLoading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh", backgroundColor: "var(--surface-base)", color: "var(--text)" }}>
        Loading BrainRouter…
      </div>
    );
  }

  // Marketing routes always render the full-bleed public shell — even when
  // signed in — so Home/About are never trapped inside the dashboard frame.
  // Protected routes fall back to the public shell only when unauthenticated
  // (AuthGuard redirects those to /auth).
  const isPublicRoute = pathname === "/" || pathname === "/about" || pathname === "/auth";

  if (isPublicRoute || !isAuthenticated) {
    return (
      <div className="public-shell">
        <PublicHeader />
        <main className="public-content">{children}</main>
      </div>
    );
  }

  const sun = (
    <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
  const moon = (
    <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );

  // Authenticated view: sidebar + modern app frame (sticky top bar + content)
  return (
    <div className="dashboard-shell">
      <Sidebar isCollapsed={isCollapsed} onToggleCollapse={handleToggleCollapse} />
      <main className="main-content">
        <header className="app-topbar">
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {isCollapsed && (
              <button onClick={handleToggleCollapse} className="topbar-btn" title="Expand sidebar" aria-label="Expand sidebar">
                <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            )}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              BrainRouter · Console
            </span>
          </div>

          <div className="topbar-right">
            <button onClick={toggleTheme} className="topbar-btn" title={theme === "light" ? "Switch to dark" : "Switch to light"} aria-label="Toggle theme">
              {theme === "light" ? moon : sun}
            </button>
            <Link href="/" className="topbar-btn" title="Landing page" aria-label="Landing page">
              <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />
              </svg>
            </Link>
            <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer" className="topbar-btn" title="GitHub repository" aria-label="GitHub repository">
              <svg style={{ width: 18, height: 18 }} viewBox="0 0 24 24" fill="currentColor">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.193 22 16.44 22 12.017 22 6.484 17.522 2 12 2z" />
              </svg>
            </a>
            <div className="topbar-user" title={user?.email}>
              <span className="topbar-avatar">{initials}</span>
              <span style={{ fontSize: 13, color: "var(--text)", fontWeight: 500, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user?.displayName ?? "Account"}
              </span>
            </div>
          </div>
        </header>

        <div className="content-scroll">{children}</div>
      </main>
    </div>
  );
}
