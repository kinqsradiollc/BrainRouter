"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { adminApi } from "../lib/adminApi";
import { useAuth } from "./AuthProvider";
import { useActiveOrg } from "./OrgWorkspaceProvider";
import { isNavItemActive, isRouteActive, PRODUCT_NAV_GROUPS, SETTINGS_NAV_GROUPS } from "./dashboardNavigation";

const settingsIconProps = {
  className: "sidebar-nav-icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Initials({ value }: { value: string }) {
  const initials = value.split(/[\s@._-]+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "B";
  return <span aria-hidden className="sidebar-avatar">{initials}</span>;
}

/** Top-of-sidebar workspace switcher (ADR-019 D1). Selecting an org scopes the
 * whole dashboard via OrgWorkspaceProvider; a "Create workspace" row spins up a
 * new org and switches to it. The menu is portaled to escape the sidebar's
 * `overflow: hidden` and anchored under the trigger. */
function WorkspaceSwitcher() {
  const { orgs, activeOrg, activeOrgId, loading, setActiveOrg, refreshOrgs } = useActiveOrg();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setCreating(false);
    setNewName("");
    setCreateError("");
  }, []);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 6, left: r.left, width: r.width });
  }, []);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      if (!prev) place();
      return !prev;
    });
  }, [place]);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    const onReflow = () => place();
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, close, place]);

  const pick = useCallback((orgId: string) => {
    setActiveOrg(orgId);
    close();
  }, [setActiveOrg, close]);

  const submitCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setCreateError("");
    try {
      const { org } = await adminApi.createOrg(name);
      await refreshOrgs();
      setActiveOrg(org.orgId);
      close();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create workspace");
    } finally {
      setBusy(false);
    }
  }, [newName, busy, refreshOrgs, setActiveOrg, close]);

  const label = activeOrg?.name || (loading ? "Loading…" : "Workspace");

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        onClick={toggle}
        className="sidebar-orgswitch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch workspace"
      >
        <Initials value={activeOrg?.name || "BrainRouter"} />
        <span className="sidebar-orgswitch-name">{label}</span>
        <svg aria-hidden className="sidebar-orgswitch-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {open && rect && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          className="sidebar-orgswitch-menu"
          role="menu"
          style={{ top: rect.top, left: rect.left, width: Math.max(rect.width, 240) }}
        >
          <div className="sidebar-orgswitch-list">
            {orgs.map((org) => {
              const active = org.orgId === activeOrgId;
              return (
                <button
                  key={org.orgId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  className={`sidebar-orgswitch-item${active ? " active" : ""}`}
                  onClick={() => pick(org.orgId)}
                >
                  <Initials value={org.name} />
                  <span className="sidebar-orgswitch-item-copy">
                    <strong>{org.name}</strong>
                    <small>{org.isPersonal ? "Personal workspace" : org.role}</small>
                  </span>
                  {active && <span aria-hidden className="sidebar-orgswitch-check">✓</span>}
                </button>
              );
            })}
            {orgs.length === 0 && <div className="sidebar-orgswitch-empty">{loading ? "Loading workspaces…" : "No workspaces"}</div>}
          </div>

          <div className="sidebar-orgswitch-create">
            {creating ? (
              <form
                onSubmit={(e) => { e.preventDefault(); void submitCreate(); }}
                className="sidebar-orgswitch-createform"
              >
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setCreating(false); setNewName(""); } }}
                  placeholder="Workspace name"
                  className="sidebar-orgswitch-input"
                  disabled={busy}
                  aria-label="New workspace name"
                />
                <div className="sidebar-orgswitch-createrow">
                  <button type="submit" className="sidebar-orgswitch-createbtn" disabled={busy || !newName.trim()}>
                    {busy ? "Creating…" : "Create"}
                  </button>
                  <button type="button" className="sidebar-orgswitch-cancelbtn" onClick={() => { setCreating(false); setNewName(""); setCreateError(""); }} disabled={busy}>Cancel</button>
                </div>
                {createError && <div className="sidebar-orgswitch-error" role="alert">{createError}</div>}
              </form>
            ) : (
              <button type="button" className="sidebar-orgswitch-additem" onClick={() => setCreating(true)}>
                <span aria-hidden className="sidebar-orgswitch-plus">+</span>
                <span>Create workspace</span>
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

interface SidebarProps {
  isMobile?: boolean;
  mobileOpen?: boolean;
  onNavigate?: () => void;
}

export function Sidebar({ isMobile = false, mobileOpen = false, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const visibleSettingsGroups = SETTINGS_NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.adminOnly || user?.isAdmin) }))
    .filter((group) => group.items.length > 0);
  const settingsMode = visibleSettingsGroups.some((group) => group.items.some((item) => isRouteActive(pathname, item.href)));
  const productNavGroups = PRODUCT_NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.adminOnly || user?.isAdmin) }))
    .filter((group) => group.items.length > 0);
  const displayName = user?.displayName || "BrainRouter user";
  const email = user?.email || "Local workspace";

  return (
    <aside className={`sidebar${isMobile ? " sidebar--mobile" : ""}${mobileOpen ? " sidebar--open" : ""}`} aria-hidden={isMobile && !mobileOpen}>
      <div className="sidebar-org-row">
        <WorkspaceSwitcher />
        {isMobile && <button type="button" onClick={onNavigate} className="sidebar-icon-button" aria-label="Close menu">×</button>}
      </div>

      {settingsMode ? (
        <nav className="sidebar-nav sidebar-nav--settings" aria-label="Settings navigation">
          <Link href="/overview" onClick={onNavigate} className="sidebar-settings-back">
            <span aria-hidden>‹</span><strong>Settings</strong>
          </Link>
          {visibleSettingsGroups.map((group) => (
            <div className="sidebar-settings-group" key={group.label}>
              <div className="sidebar-settings-group-label">{group.label}</div>
              {group.items.map((item) => {
                const active = isRouteActive(pathname, item.href);
                return <Link key={item.href} href={item.href} onClick={onNavigate} className={`sidebar-settings-link${active ? " active" : ""}`}>{item.label}</Link>;
              })}
            </div>
          ))}
        </nav>
      ) : (
        <nav className="sidebar-nav" aria-label="Product navigation">
          {productNavGroups.map((group) => (
            <div className="sidebar-product-group" key={group.label}>
              <div className="sidebar-product-group-label">{group.label}</div>
              {group.items.map((item) => (
                <Link key={item.href} href={item.href} onClick={onNavigate} className={`sidebar-nav-link${isNavItemActive(pathname, item) ? " active" : ""}`}>
                  {item.icon}<span>{item.label}</span>
                </Link>
              ))}
            </div>
          ))}
          <Link href="/profile" onClick={onNavigate} className={`sidebar-nav-link${settingsMode ? " active" : ""}`}>
            <svg {...settingsIconProps}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9A1.7 1.7 0 0 0 21 10h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></svg>
            <span>Settings</span><span className="sidebar-nav-chevron">›</span>
          </Link>
        </nav>
      )}

      <div className="sidebar-footer">
        <Link href="/about" onClick={onNavigate} className="sidebar-refer-link"><span aria-hidden>♧</span> About BrainRouter</Link>
        <button type="button" className="sidebar-user-row" onClick={logout} title="Sign out">
          <Initials value={displayName || email} />
          <span className="sidebar-user-copy"><strong>{displayName}</strong><small>{email}</small></span>
        </button>
      </div>
    </aside>
  );
}
