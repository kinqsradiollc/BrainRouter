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
    href: "/chat",
    label: "Chat",
    icon: (
      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
    )
  },
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
  }
] as const;

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({ isCollapsed, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const client = useMemo(() => getClient(), []);
  const [openContradictions, setOpenContradictions] = useState(0);

  const handleSignOut = () => {
    logout();
  };

  const visibleLinks = links.filter((link) => {
    if (link.href === "/users" && !user?.isAdmin) return false;
    return true;
  });

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
      animate={{
        width: isCollapsed ? 0 : 260,
        minWidth: isCollapsed ? 0 : 260
      }}
      transition={{ type: "spring", stiffness: 220, damping: 26 }}
      style={{
        position: "sticky",
        top: 0,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: isCollapsed ? "0px" : "24px 16px",
        background: "var(--sidebar-bg)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderRight: isCollapsed ? "0px solid transparent" : "1px solid var(--sidebar-border)",
        zIndex: 100,
        overflow: "hidden"
      }}
    >
      {/* Collapse Toggle Button (Visible only when expanded) */}
      {!isCollapsed && (
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
          marginBottom: "40px", 
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
              boxShadow: "0 0 10px var(--color-golden-accent)",
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
            MEMORY ENGINE v1.2
          </motion.div>
        )}
      </div>

      {/* Navigation List */}
      <nav style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {visibleLinks.map((link) => {
          const isActive = pathname === link.href;
          return (
            <Link 
              key={link.href} 
              href={link.href} 
              style={{ position: "relative" }}
              title={isCollapsed ? link.label : undefined}
            >
              <div 
                className={`nav-link${isActive ? " active" : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: isCollapsed ? "center" : "flex-start",
                  gap: isCollapsed ? "0" : "12px",
                  zIndex: 2,
                  position: "relative",
                  background: "transparent",
                  borderLeft: isCollapsed ? "none" : (isActive ? "2px solid var(--color-golden-accent)" : "2px solid transparent"),
                  borderRight: isCollapsed && isActive ? "2px solid var(--color-golden-accent)" : "none",
                  paddingLeft: isCollapsed ? "0" : (isActive ? "14px" : "16px"),
                  height: "44px",
                  borderRadius: isActive ? "0 9999px 9999px 0" : "9999px",
                  color: isActive ? "var(--color-pure-white)" : "var(--color-stone-text)",
                  transition: "all 0.2s ease"
                }}
              >
                {/* Custom SVG Icon Container */}
                <span style={{ 
                  color: isActive ? "var(--color-golden-accent)" : "var(--color-ash-text)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: isCollapsed ? "100%" : "auto"
                }}>
                  {link.icon}
                </span>

                {/* Text label */}
                {!isCollapsed && (
                  <motion.span
                    initial={{ opacity: 0, width: 0 }}
                    animate={{ opacity: 1, width: "auto" }}
                    exit={{ opacity: 0, width: 0 }}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {link.label}
                  </motion.span>
                )}

                {link.href === "/contradictions" && openContradictions > 0 && (
                  <span
                    style={{
                      marginLeft: "auto",
                      minWidth: "18px",
                      height: "18px",
                      borderRadius: "9999px",
                      background: "#dc2626",
                      color: "#fff",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "10px",
                      fontWeight: 700,
                      padding: "0 5px",
                    }}
                  >
                    {openContradictions}
                  </span>
                )}

                {/* Animated active background pills using layoutId */}
                {isActive && (
                  <motion.div
                    layoutId="active-pill"
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      background: "var(--nav-active-pill)",
                      borderRadius: isCollapsed ? "var(--radius-pill)" : "0 9999px 9999px 0",
                      zIndex: -1
                    }}
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
              </div>
            </Link>
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
            e.currentTarget.style.background = "rgba(174, 147, 87, 0.08)";
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
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: "#10b981", display: "inline-block" }}></span>
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
                background: "#10b981", 
                display: "inline-block",
                boxShadow: "0 0 8px #10b981"
              }}
            />
          </div>
        )}
      </div>
    </motion.aside>
  );
}
