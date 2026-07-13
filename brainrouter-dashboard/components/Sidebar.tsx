"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useAuth } from "./AuthProvider";
import { signOut } from "../lib/client-auth";
import { getClient } from "../lib/client";

const links = [
  {
    href: "/overview",
    label: "Overview",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </svg>
    )
  },
  {
    href: "/memories",
    label: "Memories",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
        <path d="M12 6v6l4 2" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
      </svg>
    )
  },
  {
    href: "/scenes",
    label: "Focus Scenes",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        <path d="M2 10h20" />
      </svg>
    )
  },
  {
    href: "/persona",
    label: "Core Identity",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    )
  },
  {
    href: "/contradictions",
    label: "Contradictions",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="m3 12 2.5-2.5L8 12M21 12l-2.5 2.5-2.5-2.5" />
        <path d="M5.5 9.5h13M18.5 14.5h-13" />
      </svg>
    )
  },
  {
    href: "/timeline",
    label: "Timeline",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 8v4l3 3" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    )
  },
  {
    href: "/recall-inspector",
    label: "Recall Inspector",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
        <path d="M8 11h6" />
        <path d="M11 8v6" />
      </svg>
    )
  },
  {
    href: "/evidence",
    label: "Evidence",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h5" />
      </svg>
    )
  },
  {
    href: "/sources",
    label: "Sources",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        <path d="M9 7h7" />
        <path d="M9 11h7" />
      </svg>
    )
  },
  {
    href: "/blackboard",
    label: "Blackboard",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="14" rx="2" />
        <path d="M7 8h10" />
        <path d="M7 12h6" />
        <path d="M12 21v-4" />
      </svg>
    )
  },
  {
    href: "/tree",
    label: "Memory Tree",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="19" r="2" />
        <path d="M12 7v4M12 11l-6 6M12 11l6 6" />
      </svg>
    )
  },
  {
    href: "/intelligence",
    label: "Graph Intelligence",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="6" cy="6" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="12" cy="18" r="2" />
        <path d="M7.5 7.5l3 9M16.5 7.5l-3 9M8 6h8" />
      </svg>
    )
  },
  {
    href: "/vault",
    label: "Vault",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="12" cy="12" r="3" />
        <path d="M12 9v-1M12 16v-1M15 12h-1M10 12H9" />
      </svg>
    )
  },
  {
    href: "/working-memory",
    label: "Working Memory",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 5h16" />
        <path d="M4 12h10" />
        <path d="M4 19h16" />
        <path d="M17 9l3 3-3 3" />
      </svg>
    )
  },
  {
    href: "/hooks",
    label: "Hooks",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M7 7h10v10H7z" />
        <path d="M3 12h4" />
        <path d="M17 12h4" />
        <path d="M12 3v4" />
        <path d="M12 17v4" />
      </svg>
    )
  },
  {
    href: "/fleet",
    label: "Fleet",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 7h18" />
        <path d="M3 12h18" />
        <path d="M3 17h18" />
        <circle cx="7" cy="7" r="0.5" />
        <circle cx="7" cy="12" r="0.5" />
        <circle cx="7" cy="17" r="0.5" />
      </svg>
    )
  },
  {
    href: "/reviews",
    label: "Reviews",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="9" />
        <path d="M9 12l2 2 4-4" />
      </svg>
    )
  },
  {
    href: "/skills",
    label: "Skill Routing",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    )
  },
  {
    href: "/profile",
    label: "Profile",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    )
  },
  {
    href: "/users",
    label: "Users",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    )
  },
  {
    href: "/brand",
    label: "Brand Studio",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    )
  },
  {
    href: "/providers",
    label: "AI Providers",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 7h16M4 12h16M4 17h10" />
        <circle cx="18" cy="17" r="2" />
      </svg>
    )
  },
  {
    href: "/organizations",
    label: "Organizations",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 21h18M6 21V7l6-4 6 4v14M10 9h.01M14 9h.01M10 13h.01M14 13h.01" />
      </svg>
    )
  },
  {
    href: "/integrations",
    label: "Integrations",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
      </svg>
    )
  }
] as const;

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Below the mobile breakpoint the rail renders as an off-canvas drawer. */
  isMobile?: boolean;
  /** Drawer open state (mobile only). */
  mobileOpen?: boolean;
  /** Called when a nav link / close button is tapped, so the drawer can close. */
  onNavigate?: () => void;
}

export function Sidebar({ isCollapsed: isCollapsedProp, onToggleCollapse, isMobile = false, mobileOpen = false, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  // On mobile the drawer always shows the full rail — the icon-only collapsed
  // state is a desktop affordance. Everything below reads this effective value.
  const isCollapsed = isMobile ? false : isCollapsedProp;
  const { user, logout } = useAuth();
  const client = useMemo(() => getClient(), []);
  const [openContradictions, setOpenContradictions] = useState(0);

  const handleSignOut = () => {
    logout();
  };

  const visibleLinks = links.filter((link) => {
    if ((link.href === "/users" || link.href === "/brand" || link.href === "/providers" || link.href === "/integrations") && !user?.isAdmin) return false;
    return true;
  });

  // Group the routes into labelled sections instead of one flat 20-item wall.
  const NAV_GROUPS: { title: string; hrefs: string[] }[] = [
    { title: "Workspace", hrefs: ["/overview"] },
    { title: "Memory", hrefs: ["/memories", "/scenes", "/persona", "/working-memory", "/blackboard", "/vault"] },
    { title: "Graph & Recall", hrefs: ["/recall-inspector", "/timeline", "/intelligence", "/tree"] },
    { title: "Integrity", hrefs: ["/contradictions", "/evidence", "/sources"] },
    { title: "System", hrefs: ["/reviews", "/hooks", "/fleet", "/skills", "/profile", "/providers", "/integrations", "/organizations", "/users", "/brand"] },
  ];
  const linkByHref = new Map<string, (typeof visibleLinks)[number]>(visibleLinks.map((l) => [l.href, l]));

  useEffect(() => {
    if (!user) return;
    client.getContradictions({ limit: 20 })
      .then((data) => {
        setOpenContradictions(data.contradictions.filter((item) => item.status === "pending").length);
      })
      .catch(() => setOpenContradictions(0));
  }, [client, user]);

  return (
    <motion.aside
      className="sidebar"
      aria-hidden={isMobile && !mobileOpen}
      animate={isMobile
        ? { x: mobileOpen ? 0 : "-101%", width: 300, minWidth: 300 }
        : { x: 0, width: isCollapsed ? 0 : 260, minWidth: isCollapsed ? 0 : 260 }}
      transition={{ type: "spring", stiffness: 220, damping: 26 }}
      style={{
        position: isMobile ? "fixed" : "sticky",
        top: 0,
        left: 0,
        height: isMobile ? "100dvh" : "100vh",
        maxWidth: isMobile ? "84vw" : undefined,
        display: "flex",
        flexDirection: "column",
        padding: isCollapsed ? "0px" : "24px 16px",
        background: isMobile ? "var(--surface-raised)" : "var(--sidebar-bg)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderRight: isCollapsed && !isMobile ? "0px solid transparent" : "1px solid var(--sidebar-border)",
        boxShadow: isMobile ? "var(--shadow-lg)" : undefined,
        zIndex: isMobile ? 300 : 100,
        overflow: "hidden"
      }}
    >
      {/* Mobile drawer close (✕) — only in off-canvas mode. */}
      {isMobile && (
        <button
          onClick={onNavigate}
          aria-label="Close menu"
          style={{
            position: "absolute",
            top: "20px",
            right: "16px",
            width: "34px",
            height: "34px",
            borderRadius: "8px",
            background: "var(--surface-overlay)",
            border: "1px solid var(--border-med)",
            color: "var(--text-secondary)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            zIndex: 110,
          }}
        >
          <svg style={{ width: "18px", height: "18px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}

      {/* Collapse Toggle Button (Visible only when expanded, desktop only) */}
      {!isCollapsed && !isMobile && (
        <button
          onClick={onToggleCollapse}
          style={{
            position: "absolute",
            top: "32px",
            right: "12px",
            width: "24px",
            height: "24px",
            borderRadius: "50%",
            background: "var(--color-midnight-ink)",
            border: "1px solid var(--border-med)",
            color: "var(--color-stone-text)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            zIndex: 110,
            transition: "all 0.2s ease",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)"
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.color = "var(--color-pure-white)";
            e.currentTarget.style.borderColor = "var(--color-golden-accent)";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.color = "var(--color-stone-text)";
            e.currentTarget.style.borderColor = "var(--border-med)";
          }}
        >
          <svg
            style={{
              width: "12px",
              height: "12px",
              transform: "rotate(0deg)",
              transition: "transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)"
            }}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      )}

      {/* Brand Header */}
      <div
        style={{
          marginBottom: "16px",
          display: "flex", 
          flexDirection: "column", 
          alignItems: isCollapsed ? "center" : "flex-start",
          width: "100%",
          overflow: "hidden",
          padding: "0 8px"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px", justifyContent: isCollapsed ? "center" : "flex-start", width: "100%" }}>
          <div 
            style={{ 
              width: "10px", 
              height: "10px", 
              borderRadius: "50%",
              background: "var(--color-golden-accent)",
              flexShrink: 0
            }} 
          />
          {!isCollapsed && (
            <motion.h2 
              className="serif-display" 
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: "auto" }}
              exit={{ opacity: 0, width: 0 }}
              style={{ margin: 0, fontSize: "24px", color: "var(--color-pure-white)", whiteSpace: "nowrap" }}
            >
              BrainRouter
            </motion.h2>
          )}
        </div>
        {!isCollapsed && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{ color: "var(--color-ash-text)", fontSize: "11px", letterSpacing: "0.05em", marginTop: "4px", paddingLeft: "20px", whiteSpace: "nowrap" }}
          >
MEMORY ENGINE
          </motion.div>
        )}
      </div>

      {/* Grouped, scrollable navigation */}
      <nav style={{ display: "flex", flexDirection: "column", gap: isCollapsed ? "4px" : "2px", flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", marginRight: "-8px", paddingRight: "8px" }}>
        {NAV_GROUPS.map((group) => {
          const groupLinks = group.hrefs.map((h) => linkByHref.get(h)).filter(Boolean) as typeof visibleLinks;
          if (groupLinks.length === 0) return null;
          return (
            <div key={group.title} style={{ display: "flex", flexDirection: "column", gap: "2px", marginBottom: "8px" }}>
              {!isCollapsed ? (
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.11em", textTransform: "uppercase", color: "var(--text-muted)", padding: "12px 12px 4px" }}>
                  {group.title}
                </div>
              ) : (
                <div style={{ height: "1px", background: "var(--border-dim)", margin: "6px 10px" }} />
              )}
              {groupLinks.map((link) => {
                const isActive = pathname === link.href;
                return (
                  <Link key={link.href} href={link.href} onClick={onNavigate} style={{ position: "relative" }} title={isCollapsed ? link.label : undefined}>
                    <div
                      className={`nav-link${isActive ? " active" : ""}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: isCollapsed ? "center" : "flex-start",
                        gap: isCollapsed ? "0" : "11px",
                        zIndex: 2,
                        position: "relative",
                        background: "transparent",
                        borderLeft: isCollapsed ? "none" : "2px solid transparent",
                        borderRight: isCollapsed && isActive ? "2px solid var(--accent)" : "none",
                        paddingLeft: isCollapsed ? "0" : "15px",
                        height: "36px",
                        borderRadius: isActive ? "0 8px 8px 0" : "8px",
                        color: isActive ? "var(--text)" : "var(--text-secondary)",
                        fontSize: "13.5px",
                        fontWeight: isActive ? 500 : 400,
                        transition: "color .16s var(--ease), background .16s var(--ease), border-color .16s var(--ease)",
                      }}
                    >
                      <span style={{ color: isActive ? "var(--accent)" : "var(--text-muted)", display: "inline-flex", alignItems: "center", justifyContent: "center", width: isCollapsed ? "100%" : "auto", flexShrink: 0 }}>
                        {link.icon}
                      </span>
                      {!isCollapsed && <span style={{ whiteSpace: "nowrap" }}>{link.label}</span>}
                      {link.href === "/contradictions" && openContradictions > 0 && !isCollapsed && (
                        <span style={{ marginLeft: "auto", minWidth: "18px", height: "18px", borderRadius: "9999px", background: "var(--danger)", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "10px", fontWeight: 700, padding: "0 5px" }}>
                          {openContradictions}
                        </span>
                      )}
                      {isActive && (
                        <motion.div
                          layoutId="active-pill"
                          style={{ position: "absolute", inset: 0, background: "var(--accent-wash)", borderRadius: isCollapsed ? "8px" : "0 8px 8px 0", zIndex: -1 }}
                          transition={{ type: "spring", stiffness: 380, damping: 30 }}
                        />
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
        <button
          onClick={handleSignOut}
          title={isCollapsed ? "Sign Out" : undefined}
          style={{
            background: "transparent",
            border: "1px solid var(--border-dim)",
            color: "var(--color-stone-text)",
            padding: "8px",
            borderRadius: "var(--radius-pill)",
            fontSize: "13px",
            cursor: "pointer",
            textAlign: "center",
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "38px",
            transition: "all 0.2s ease"
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.color = "var(--color-pure-white)";
            e.currentTarget.style.borderColor = "var(--color-golden-accent)";
            e.currentTarget.style.background = "rgba(52, 194, 142, 0.08)";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.color = "var(--color-stone-text)";
            e.currentTarget.style.borderColor = "var(--border-dim)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          {isCollapsed ? (
            <svg style={{ width: "18px", height: "18px" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          ) : "Sign Out"}
        </button>

        {!isCollapsed ? (
          <div style={{ padding: "10px", borderTop: "1px solid var(--border-dim)" }}>
            <div style={{ fontSize: "11px", color: "var(--color-ash-text)" }}>OPERATIONAL MODE</div>
            <div style={{ fontSize: "12px", color: "var(--color-pure-white)", fontWeight: 500, display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#34C28E", display: "inline-block" }}></span>
              SQLite Active
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "center", padding: "10px 0", borderTop: "1px solid var(--border-dim)" }}>
            <span 
              title="SQLite Active (Operational)"
              style={{ 
                width: "8px", 
                height: "8px", 
                borderRadius: "50%", 
                background: "#34C28E",
                display: "inline-block"
              }}
            />
          </div>
        )}
      </div>
    </motion.aside>
  );
}
