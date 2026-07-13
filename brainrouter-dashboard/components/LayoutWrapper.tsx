"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { Sidebar } from "./Sidebar";
import { PublicHeader } from "./PublicHeader";
import { CommandPalette } from "./CommandPalette";
import { useIsMobile } from "../lib/useIsMobile";

export function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const isMobile = useIsMobile(768);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => { setMobileNavOpen(false); }, [pathname]);
  useEffect(() => { if (!isMobile) setMobileNavOpen(false); }, [isMobile]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.style.overflow = isMobile && mobileNavOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [isMobile, mobileNavOpen]);

  if (isLoading) {
    return <div className="app-loading">Loading BrainRouter…</div>;
  }

  const isPublicRoute = pathname === "/" || pathname === "/about" || pathname === "/auth";
  if (isPublicRoute || !isAuthenticated) {
    return <div className="public-shell"><PublicHeader /><main className="public-content">{children}</main></div>;
  }

  return (
    <div className="dashboard-shell">
      <Sidebar isMobile={isMobile} mobileOpen={mobileNavOpen} onNavigate={() => setMobileNavOpen(false)} />
      {isMobile && mobileNavOpen && <button type="button" className="sidebar-backdrop" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation" />}
      <main className="main-content">
        {isMobile && (
          <div className="mobile-appbar">
            <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open menu" className="sidebar-icon-button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
            </button>
          </div>
        )}
        <div className="app-notice" role="status">
          <span>Plan, build, connect, remember, and verify from one workspace.</span>
          <Link href="/status">System status</Link>
        </div>
        <div className="content-scroll">{children}</div>
      </main>
      <CommandPalette />
    </div>
  );
}
