"use client";

import { useAuth } from "./AuthProvider";
import { Sidebar } from "./Sidebar";
import { PublicHeader } from "./PublicHeader";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();

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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh", backgroundColor: "var(--color-midnight-ink)", color: "var(--color-pure-white)" }}>
        Loading BrainRouter...
      </div>
    );
  }

  // Public routes
  const isPublicRoute = pathname === "/" || pathname === "/about" || pathname === "/auth";

  // If not authenticated or on a public route while unauthenticated
  if (!isAuthenticated || (isPublicRoute && pathname === "/auth")) {
    return (
      <div className="public-shell">
        <PublicHeader />
        <main className="public-content">{children}</main>
      </div>
    );
  }

  // Authenticated view: Sidebar layout
  return (
    <div className="dashboard-shell">
      <Sidebar isCollapsed={isCollapsed} onToggleCollapse={handleToggleCollapse} />
      <main className="main-content" style={{ position: "relative" }}>
        {/* Floating Expand Trigger Button (Visible only when collapsed) */}
        {isCollapsed && (
          <button
            onClick={handleToggleCollapse}
            title="Expand Sidebar"
            style={{
              position: "fixed",
              top: "24px",
              left: "24px",
              width: "38px",
              height: "38px",
              borderRadius: "50%",
              background: "rgba(23, 24, 30, 0.6)",
              border: "1px solid rgba(226, 227, 233, 0.12)",
              color: "var(--color-stone-text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              zIndex: 110,
              transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
              backdropFilter: "blur(16px)",
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.2)"
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "var(--color-pure-white)";
              e.currentTarget.style.borderColor = "var(--color-golden-accent)";
              e.currentTarget.style.background = "rgba(174, 147, 87, 0.12)";
              e.currentTarget.style.transform = "scale(1.05)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "var(--color-stone-text)";
              e.currentTarget.style.borderColor = "rgba(226, 227, 233, 0.12)";
              e.currentTarget.style.background = "rgba(23, 24, 30, 0.6)";
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            <svg style={{ width: "18px", height: "18px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        {/* Floating Utility Toolbar */}
        <div style={{
          position: "absolute",
          top: "32px",
          right: "40px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          zIndex: 10
        }}>
          {/* Home Link */}
          <Link
            href="/"
            title="Go to Public Landing Page"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "38px",
              height: "38px",
              borderRadius: "50%",
              background: "rgba(23, 24, 30, 0.4)",
              border: "1px solid rgba(226, 227, 233, 0.08)",
              color: "var(--color-stone-text)",
              cursor: "pointer",
              transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.15)"
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "var(--color-pure-white)";
              e.currentTarget.style.borderColor = "var(--color-golden-accent)";
              e.currentTarget.style.background = "rgba(174, 147, 87, 0.1)";
              e.currentTarget.style.transform = "scale(1.05)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "var(--color-stone-text)";
              e.currentTarget.style.borderColor = "rgba(226, 227, 233, 0.08)";
              e.currentTarget.style.background = "rgba(23, 24, 30, 0.4)";
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            <svg style={{ width: "18px", height: "18px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </Link>

          {/* About Us Link */}
          <Link
            href="/about"
            title="Read About BrainRouter"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "38px",
              height: "38px",
              borderRadius: "50%",
              background: "rgba(23, 24, 30, 0.4)",
              border: "1px solid rgba(226, 227, 233, 0.08)",
              color: "var(--color-stone-text)",
              cursor: "pointer",
              transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.15)"
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "var(--color-pure-white)";
              e.currentTarget.style.borderColor = "var(--color-golden-accent)";
              e.currentTarget.style.background = "rgba(174, 147, 87, 0.1)";
              e.currentTarget.style.transform = "scale(1.05)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "var(--color-stone-text)";
              e.currentTarget.style.borderColor = "rgba(226, 227, 233, 0.08)";
              e.currentTarget.style.background = "rgba(23, 24, 30, 0.4)";
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            <svg style={{ width: "18px", height: "18px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
          </Link>

          {/* Floating GitHub Repository Link */}
          <a
            href="https://github.com/kinqsradiollc/BrainRouter"
            target="_blank"
            rel="noopener noreferrer"
            title="View GitHub Repository"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "38px",
              height: "38px",
              borderRadius: "50%",
              background: "rgba(23, 24, 30, 0.4)",
              border: "1px solid rgba(226, 227, 233, 0.08)",
              color: "var(--color-stone-text)",
              cursor: "pointer",
              transition: "all 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 4px 20px rgba(0, 0, 0, 0.15)"
            }}
            onMouseOver={(e) => {
              e.currentTarget.style.color = "var(--color-pure-white)";
              e.currentTarget.style.borderColor = "var(--color-golden-accent)";
              e.currentTarget.style.background = "rgba(174, 147, 87, 0.1)";
              e.currentTarget.style.transform = "scale(1.05)";
              e.currentTarget.style.boxShadow = "0 8px 30px rgba(174, 147, 87, 0.15)";
            }}
            onMouseOut={(e) => {
              e.currentTarget.style.color = "var(--color-stone-text)";
              e.currentTarget.style.borderColor = "rgba(226, 227, 233, 0.08)";
              e.currentTarget.style.background = "rgba(23, 24, 30, 0.4)";
              e.currentTarget.style.transform = "scale(1)";
              e.currentTarget.style.boxShadow = "0 4px 20px rgba(0, 0, 0, 0.15)";
            }}
          >
            <svg style={{ width: "20px", height: "20px" }} viewBox="0 0 24 24" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.193 22 16.44 22 12.017 22 6.484 17.522 2 12 2z" />
            </svg>
          </a>
        </div>
        {children}
      </main>
    </div>
  );
}
