"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { useTheme } from "./ThemeProvider";

/**
 * CommandPalette — ⌘K / Ctrl+K fast navigation across the dashboard.
 * Opens on the shortcut or a window "open-command-palette" event (the top-bar
 * button dispatches it). Keyboard-navigable; design-token styled. Self-contained
 * state so it can be dropped once in the authed shell.
 */

interface Cmd {
  label: string;
  group: string;
  href?: string;
  action?: () => void;
  keywords?: string;
}

const ROUTES: { label: string; group: string; href: string }[] = [
  { label: "Overview", group: "Workspace", href: "/overview" },
  { label: "Memories", group: "Memory", href: "/memories" },
  { label: "Focus Scenes", group: "Memory", href: "/scenes" },
  { label: "Core Identity", group: "Memory", href: "/persona" },
  { label: "Working Memory", group: "Memory", href: "/working-memory" },
  { label: "Blackboard", group: "Memory", href: "/blackboard" },
  { label: "Vault", group: "Memory", href: "/vault" },
  { label: "Recall Inspector", group: "Graph & Recall", href: "/recall-inspector" },
  { label: "Timeline", group: "Graph & Recall", href: "/timeline" },
  { label: "Graph Intelligence", group: "Graph & Recall", href: "/intelligence" },
  { label: "Memory Tree", group: "Graph & Recall", href: "/tree" },
  { label: "Contradictions", group: "Integrity", href: "/contradictions" },
  { label: "Evidence", group: "Integrity", href: "/evidence" },
  { label: "Sources", group: "Integrity", href: "/sources" },
  { label: "Hooks", group: "Integrity", href: "/hooks" },
  { label: "Skill Routing", group: "System", href: "/skills" },
  { label: "Profile", group: "System", href: "/profile" },
  { label: "Users", group: "System", href: "/users" },
];

export function CommandPalette() {
  const router = useRouter();
  const { logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const commands: Cmd[] = useMemo(
    () => [
      ...ROUTES.map((r) => ({ label: r.label, group: r.group, href: r.href })),
      { label: theme === "light" ? "Switch to dark theme" : "Switch to light theme", group: "Actions", action: toggleTheme, keywords: "theme dark light appearance" },
      { label: "Go to landing page", group: "Actions", action: () => router.push("/"), keywords: "home marketing" },
      { label: "Sign out", group: "Actions", action: () => logout(), keywords: "logout exit" },
    ],
    [theme, toggleTheme, router, logout],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => (c.label + " " + c.group + " " + (c.keywords ?? "")).toLowerCase().includes(q));
  }, [query, commands]);

  // Global shortcut + external open event
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const run = (c: Cmd) => {
    setOpen(false);
    if (c.href) router.push(c.href);
    else c.action?.();
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = filtered[active];
      if (c) run(c);
    }
  };

  let lastGroup = "";

  return (
    <div
      onMouseDown={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.5)",
        backdropFilter: "blur(3px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onListKey}
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "62vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface-overlay)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-panel)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages and actions…"
          style={{
            width: "100%",
            padding: "16px 18px",
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--border)",
            color: "var(--text)",
            fontSize: "15px",
            outline: "none",
            fontFamily: "var(--font-sans)",
          }}
        />
        <div style={{ overflowY: "auto", padding: "8px" }}>
          {filtered.length === 0 && (
            <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>No matches</div>
          )}
          {filtered.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            const isActive = i === active;
            return (
              <div key={c.label}>
                {showGroup && (
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: "10px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", padding: "10px 10px 4px" }}>
                    {c.group}
                  </div>
                )}
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "9px 12px",
                    borderRadius: "var(--radius-control)",
                    border: "none",
                    cursor: "pointer",
                    background: isActive ? "var(--accent-wash)" : "transparent",
                    color: isActive ? "var(--text)" : "var(--text-secondary)",
                    fontSize: "13.5px",
                    fontFamily: "var(--font-sans)",
                  }}
                >
                  <span style={{ width: "5px", height: "5px", borderRadius: "9999px", background: isActive ? "var(--accent)" : "var(--text-muted)", flexShrink: 0 }} />
                  {c.label}
                  {c.href && <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)" }}>{c.href}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: "14px", padding: "8px 14px", borderTop: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--text-muted)" }}>
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
