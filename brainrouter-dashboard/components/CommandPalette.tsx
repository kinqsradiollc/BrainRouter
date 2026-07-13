"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { PRODUCT_NAV_GROUPS, SETTINGS_NAV_GROUPS } from "./dashboardNavigation";

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

const KNOWLEDGE_DETAIL_ROUTES: Cmd[] = [
  { label: "Saved knowledge", group: "Knowledge details", href: "/memories", keywords: "decisions preferences lessons" },
  { label: "Connected sources", group: "Knowledge details", href: "/sources", keywords: "documents conversations" },
  { label: "Current task context", group: "Knowledge details", href: "/working-memory" },
  { label: "Recall details", group: "Knowledge details", href: "/recall-inspector", keywords: "why recalled" },
  { label: "Topic summaries", group: "Knowledge details", href: "/scenes" },
  { label: "Knowledge map", group: "Knowledge details", href: "/tree" },
];

export function CommandPalette() {
  const router = useRouter();
  const { logout, user } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleId = useId();
  const listId = useId();

  const commands: Cmd[] = useMemo(
    () => [
      ...PRODUCT_NAV_GROUPS.flatMap((group) => group.items
        .filter((item) => !item.adminOnly || user?.isAdmin)
        .map((item) => ({ label: item.label, group: group.label, href: item.href, keywords: item.keywords }))),
      ...KNOWLEDGE_DETAIL_ROUTES,
      ...SETTINGS_NAV_GROUPS.flatMap((group) => group.items
        .filter((item) => !item.adminOnly || user?.isAdmin)
        .map((item) => ({ label: item.label, group: `Settings · ${group.label}`, href: item.href, keywords: item.keywords }))),
      { label: "Go to landing page", group: "Actions", action: () => router.push("/"), keywords: "home marketing" },
      { label: "Sign out", group: "Actions", action: () => logout(), keywords: "logout exit" },
    ],
    [router, logout, user?.isAdmin],
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
      setActive((a) => Math.max(0, Math.min(a + 1, filtered.length - 1)));
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
      className="command-palette-backdrop"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onListKey}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="command-palette-heading"><span id={titleId}>Quick switch</span><kbd>⌘ K</kbd></div>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search pages and actions…"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={filtered[active] ? `command-palette-option-${active}` : undefined}
          className="command-palette-input"
        />
        <div id={listId} role="listbox" className="command-palette-list">
          {filtered.length === 0 && (
            <div className="command-palette-empty">No matching page or action</div>
          )}
          {filtered.map((c, i) => {
            const showGroup = c.group !== lastGroup;
            lastGroup = c.group;
            const isActive = i === active;
            return (
              <div key={c.label}>
                {showGroup && (
                  <div className="command-palette-group">{c.group}</div>
                )}
                <button
                  id={`command-palette-option-${i}`}
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={`command-palette-option${isActive ? " active" : ""}`}
                >
                  <span className="command-palette-option-dot" />
                  {c.label}
                  {c.href && <span className="command-palette-path">{c.href}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="command-palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
