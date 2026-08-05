import React, { type ReactNode } from "react";

export type DashboardNavItem = {
  href: string;
  label: string;
  icon?: ReactNode;
  adminOnly?: boolean;
  activeHrefs?: readonly string[];
  keywords?: string;
};

export type DashboardNavGroup = {
  label: string;
  items: DashboardNavItem[];
};

const iconProps = {
  className: "sidebar-nav-icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const KNOWLEDGE_ROUTES = [
  "/knowledge",
  "/memories",
  "/sources",
  "/working-memory",
  "/scenes",
  "/evidence",
  "/contradictions",
  "/recall-inspector",
  "/timeline",
  "/tree",
  "/intelligence",
  "/persona",
  "/blackboard",
  "/vault",
] as const;

export const PRODUCT_NAV_GROUPS: DashboardNavGroup[] = [
  {
    label: "Work",
    items: [
      { href: "/overview", label: "Overview", keywords: "dashboard home", icon: <svg {...iconProps}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg> },
      { href: "/chat", label: "Agent workbench", keywords: "chat ask build task", icon: <svg {...iconProps}><path d="M21 11.5a8.5 8.5 0 0 1-9 8.5 9.4 9.4 0 0 1-4-.9L3 21l1.7-4.5A8.5 8.5 0 1 1 21 11.5Z" /></svg> },
      { href: "/meetings", label: "Meetings", keywords: "record transcript summary notes", icon: <svg {...iconProps}><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg> },
      { href: "/teams", label: "Teams", keywords: "team members group share collaborators people", icon: <svg {...iconProps}><path d="M16 19v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="3" /><path d="M22 19v-2a4 4 0 0 0-3-3.87M16 4.13A4 4 0 0 1 16 11.9" /></svg> },
      { href: "/track", label: "Track", keywords: "board tasks work items sprint kanban todo", icon: <svg {...iconProps}><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="10" rx="1" /><rect x="17" y="4" width="4" height="13" rx="1" /></svg> },
      // ADR-028 G6 — the planner is PERSONAL and cross-project, unlike Track,
      // which is org-collaborative and per-project. A Track item appears in the
      // planner as a mirrored item; neither replaces the other.
      { href: "/planner", label: "Planner", keywords: "today calendar notes plan day schedule todo personal", icon: <svg {...iconProps}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg> },
    ],
  },
  {
    label: "Review",
    items: [
      { href: "/reviews", label: "PR reviews", keywords: "pull request quality", icon: <svg {...iconProps}><path d="M6 3v12" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M8 6h8M18 8v10" /></svg> },
      { href: "/issues", label: "Issues", keywords: "findings attention", icon: <svg {...iconProps}><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></svg> },
      { href: "/pentests", label: "Pentests", keywords: "assessment", icon: <svg {...iconProps}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg> },
      { href: "/vulnerabilities", label: "CVE", keywords: "cve vulnerability exposure kev epss", icon: <svg {...iconProps}><path d="M12 3l8 4v5c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V7l8-4Z" /><path d="M12 8v4M12 15h.01" /></svg> },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/projects", label: "Projects", keywords: "workspace", icon: <svg {...iconProps}><path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5Z" /><path d="M3 7.5V5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v2.5" /></svg> },
      { href: "/repositories", label: "Repositories", keywords: "source code github", icon: <svg {...iconProps}><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></svg> },
      { href: "/knowledge", label: "Knowledge", keywords: "memory context recall", activeHrefs: KNOWLEDGE_ROUTES, icon: <svg {...iconProps}><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></svg> },
      { href: "/integrations", label: "Connections", keywords: "integrations connectors mcp", icon: <svg {...iconProps}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M17.5 14v7M14 17.5h7" /></svg> },
    ],
  },
  {
    label: "Operate",
    items: [
      { href: "/fleet", label: "Automation", keywords: "agents hooks running work", icon: <svg {...iconProps}><path d="M4 7h16M7 4v6M5 14h14v6H5z" /><path d="M9 17h.01M13 17h2" /></svg> },
      { href: "/domains", label: "Domains", icon: <svg {...iconProps}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg> },
      { href: "/networks", label: "Networks", icon: <svg {...iconProps}><circle cx="6" cy="12" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="18" cy="18" r="2" /><path d="m8 11 8-4M8 13l8 4" /></svg> },
    ],
  },
];

export const SETTINGS_NAV_GROUPS: DashboardNavGroup[] = [
  { label: "Account", items: [{ href: "/profile", label: "General", keywords: "profile account" }] },
  {
    label: "Workspace",
    items: [
      { href: "/organizations", label: "Organizations" },
      { href: "/users", label: "Members", adminOnly: true },
      { href: "/review-automation", label: "Review automation", keywords: "pull request review policy repositories" },
    ],
  },
  { label: "Intelligence", items: [
    // Visible to every member: the backend gates writes per-org (models:manage /
    // providers:manage), and the page itself disables admin-only tabs. Gating the
    // NAV on the instance-admin flag hid the managed-models editor from org
    // owners entirely (the "can't configure managed models anywhere" bug).
    { href: "/providers", label: "Models & providers", keywords: "llm managed models byok" },
  ] },
  { label: "Notifications", items: [{ href: "/email-settings", label: "Email", adminOnly: true }] },
  {
    label: "Advanced",
    items: [
      { href: "/brand", label: "Brand studio", adminOnly: true },
      { href: "/admin-orgs", label: "Administration", adminOnly: true },
    ],
  },
];

export function isRouteActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isNavItemActive(pathname: string, item: DashboardNavItem) {
  return (item.activeHrefs ?? [item.href]).some((href) => isRouteActive(pathname, href));
}
