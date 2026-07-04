/**
 * PLUGIN-MARKETPLACE P4-desktop — renderer-side view types for the Marketplace
 * panel. These MIRROR the host's `pluginBridge` return shapes but are declared
 * independently so the renderer stays browser-safe (no core deep-import that
 * would pull node:fs/git into the vite bundle — the renderer-bundle rule).
 */

/** Counts of what a plugin contributes (registry `provides` + installed tally). */
export interface PluginProvidesView {
  skills?: number;
  agents?: number;
  commands?: number;
  hooks?: number;
  mcpServers?: number;
  connectors?: number;
  workflows?: number;
}

/** A hosted-registry entry surfaced by the browse grid (`plugin-search`). */
export interface RegistryPluginView {
  id: string;
  name: string;
  repo: string;
  version?: string;
  category?: string;
  tags: string[];
  stars: number;
  lastUpdated?: string;
  author?: string;
  description?: string;
  provides: PluginProvidesView;
}

/** One ranked search hit (entry + relevance score). */
export interface RegistrySearchHit {
  entry: RegistryPluginView;
  score: number;
}

/** An installed plugin, enriched with consent + update state (`plugin-list`). */
export interface InstalledPluginView {
  name: string;
  scope: 'user' | 'workspace' | 'org';
  readOnly?: boolean;
  version?: string;
  description?: string;
  author?: string;
  category?: string;
  enabled: boolean;
  provides: PluginProvidesView;
  requiresConsent: boolean;
  shellApproved: boolean;
  mcpApproved: boolean;
  updateAvailable?: string;
  source?: string;
  ref?: string;
}

/** The capability disclosure shown in the install/enable consent dialog. */
export interface ConsentSummaryView {
  name: string;
  version?: string;
  provides: PluginProvidesView;
  hookCommands: Array<{ label: string; command: string; kind?: string }>;
  mcpCommands: Array<{ label: string; command: string; kind?: string }>;
  requiresConsent: boolean;
  shellApproved: boolean;
  mcpApproved: boolean;
  compatibilityWarnings: string[];
  disclosure: string;
}

/** The Marketplace panel's data slice, threaded from App state. */
export interface MarketplaceState {
  /** Installed plugins (null = not yet loaded). */
  installed: InstalledPluginView[] | null;
  /** Registry search hits (null = not yet searched). */
  hits: RegistrySearchHit[] | null;
  /** True while a browse/search is in flight. */
  searching: boolean;
  /** Registry error (empty = none). */
  error: string;
  /** A pending consent disclosure to confirm before install/enable. */
  consent: { plugin: string; scope: 'user' | 'workspace'; action: 'install' | 'enable'; summary: ConsentSummaryView } | null;
}

export const CATEGORIES = ['development', 'productivity', 'research', 'design', 'security', 'data'] as const;

/** Human summary of a provides tally (e.g. "3 skills · 2 hooks"). */
export function describeProvides(p: PluginProvidesView): string {
  const parts: string[] = [];
  const push = (n: number | undefined, one: string): void => { if (n) parts.push(`${n} ${n === 1 ? one : `${one}s`}`); };
  push(p.skills, 'skill');
  push(p.agents, 'agent');
  push(p.commands, 'command');
  push(p.hooks, 'hook');
  push(p.mcpServers, 'MCP server');
  push(p.connectors, 'connector');
  push(p.workflows, 'workflow');
  return parts.length ? parts.join(' · ') : 'nothing';
}
