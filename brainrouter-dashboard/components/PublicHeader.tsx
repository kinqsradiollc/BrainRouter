"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "./AuthProvider";
import { useIsMobile } from "../lib/useIsMobile";
import { STATIC_PRESENTATION } from "../lib/presentation";

const DOCS_URL = "https://github.com/kinqsradiollc/BrainRouter/tree/HEAD/brainrouter-docs";
const NAV = [
  { label: "Home", href: "/" },
  { label: "Workbench", href: "/#platform" },
  { label: "Knowledge", href: "/#knowledge" },
  { label: "Surfaces", href: "/#workflows" },
  { label: "About", href: "/about" },
] as const;

export function PublicHeader() {
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();
  const isMobile = useIsMobile(768);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => { if (!isMobile) setMenuOpen(false); }, [isMobile]);

  return (
    <header className="public-header">
      <div className="public-header-inner">
        <nav className="public-nav" aria-label="Public navigation">
          {NAV.map((item) => <Link key={item.label} href={item.href} className={`public-nav-link${pathname === item.href ? " active" : ""}`}>{item.label}</Link>)}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="public-nav-link">Docs</a>
          <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer" className="public-nav-link">GitHub</a>
          {!STATIC_PRESENTATION && <Link href={isAuthenticated ? "/overview" : "/auth"} className="public-header-cta">{isAuthenticated ? "Open dashboard" : "Sign in"}</Link>}
        </nav>
        <button type="button" className="public-menu-btn" onClick={() => setMenuOpen((open) => !open)} aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen}>
          {menuOpen ? "×" : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M4 12h16M4 17h16" /></svg>}
        </button>
      </div>
      {menuOpen && (
        <nav className="public-menu-panel" aria-label="Mobile public navigation">
          {NAV.map((item) => <Link key={item.label} href={item.href} className="public-menu-link">{item.label}</Link>)}
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className="public-menu-link">Docs</a>
          <a href="https://github.com/kinqsradiollc/BrainRouter" target="_blank" rel="noopener noreferrer" className="public-menu-link">GitHub</a>
          {!STATIC_PRESENTATION && <Link href={isAuthenticated ? "/overview" : "/auth"} className="public-header-cta">{isAuthenticated ? "Open dashboard" : "Sign in"}</Link>}
        </nav>
      )}
    </header>
  );
}
