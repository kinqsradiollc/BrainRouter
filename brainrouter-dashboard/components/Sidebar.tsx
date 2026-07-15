"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { BrainRouterLogo } from "./BrainRouterLogo";
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
        <Link href="/overview" onClick={onNavigate} className="sidebar-org" aria-label="Dashboard home">
          <BrainRouterLogo className="sidebar-org-mark" size={16} showWordmark={false} />
        </Link>
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
