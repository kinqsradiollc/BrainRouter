/**
 * PLUGIN-MARKETPLACE P5 — SESSION-START auto-update CHECK (plan §4/P5).
 *
 * When `cli.plugins.autoUpdateCheck` is on (default OFF), compare each installed
 * plugin's version against the hosted registry's `version`/`lastUpdated` and
 * surface an "updates available" notice. This NEVER auto-installs — it only
 * reports what a `brainrouter plugin update` would fetch. The check is:
 *   - gated off by default (inert),
 *   - a SOFT failure (a registry that won't fetch just yields no notice),
 *   - PURE given an injected registry index (so it's testable without network).
 *
 * BrainRouter conventions only — never `.claude`.
 */
import { listInstalledPlugins, type InstalledPlugin } from './installed.js';
import { fetchRegistry, resolveRegistryUrl, findRegistryEntry, type RegistryIndex, type RegistryEntry } from './registry.js';
import type { PluginScope } from './paths.js';

export interface AvailableUpdate {
  name: string;
  scope: PluginScope;
  installedVersion?: string;
  registryVersion?: string;
  registryLastUpdated?: string;
  /** Why we consider this an update (version bump / newer timestamp). */
  reason: 'version' | 'lastUpdated';
}

/** Compare two dotted version strings; returns true when `b` is strictly newer than `a`. */
export function isNewerVersion(a: string | undefined, b: string | undefined): boolean {
  const av = (a ?? '').trim();
  const bv = (b ?? '').trim();
  if (!bv) return false;
  if (!av) return true;
  if (av === bv) return false;
  const pa = av.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = bv.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

/**
 * Compute which installed plugins have a newer registry entry. PURE — takes an
 * already-fetched registry index + the installed list. An update is surfaced when
 * the registry `version` is strictly newer, or (when no versions are comparable)
 * the registry `lastUpdated` is a later date than the install timestamp.
 */
export function computeAvailableUpdates(installed: InstalledPlugin[], index: RegistryIndex): AvailableUpdate[] {
  const out: AvailableUpdate[] = [];
  for (const plugin of installed) {
    const entry: RegistryEntry | undefined = findRegistryEntry(index, plugin.name);
    if (!entry) continue;
    if (isNewerVersion(plugin.version, entry.version)) {
      out.push({
        name: plugin.name,
        scope: plugin.scope,
        installedVersion: plugin.version,
        registryVersion: entry.version,
        registryLastUpdated: entry.lastUpdated,
        reason: 'version',
      });
      continue;
    }
    // Fallback: no comparable version bump — use the lastUpdated date vs install time.
    if (!plugin.version && !entry.version && entry.lastUpdated && plugin.record?.installedAt) {
      const reg = Date.parse(entry.lastUpdated);
      const inst = Date.parse(plugin.record.installedAt);
      if (Number.isFinite(reg) && Number.isFinite(inst) && reg > inst) {
        out.push({
          name: plugin.name,
          scope: plugin.scope,
          installedVersion: plugin.version,
          registryVersion: entry.version,
          registryLastUpdated: entry.lastUpdated,
          reason: 'lastUpdated',
        });
      }
    }
  }
  return out;
}

export interface AutoUpdateCheckResult {
  /** True when the check ran (gate on). */
  ran: boolean;
  updates: AvailableUpdate[];
  /** A one-line human notice, empty when nothing to report. */
  notice: string;
  /** A soft error (registry fetch failed) — the check is best-effort. */
  error?: string;
}

/**
 * Run the session-start check. Gated by `enabled`; returns `{ ran: false }` when
 * off. Fetches the configured registry (soft-fails), then diffs against installed
 * plugins. NEVER installs anything.
 */
export async function runAutoUpdateCheck(opts: {
  enabled: boolean;
  workspaceRoot: string;
  registryUrl?: string;
}): Promise<AutoUpdateCheckResult> {
  if (!opts.enabled) return { ran: false, updates: [], notice: '' };
  const installed = listInstalledPlugins(opts.workspaceRoot);
  if (installed.length === 0) return { ran: true, updates: [], notice: '' };
  const fetched = await fetchRegistry(resolveRegistryUrl(opts.registryUrl));
  if (!fetched.ok) return { ran: true, updates: [], notice: '', error: fetched.error };
  const updates = computeAvailableUpdates(installed, fetched.index);
  return { ran: true, updates, notice: formatUpdateNotice(updates) };
}

/** Format the "updates available" notice (empty when none). */
export function formatUpdateNotice(updates: AvailableUpdate[]): string {
  if (updates.length === 0) return '';
  const list = updates
    .map((u) => `${u.name}${u.installedVersion ? ` ${u.installedVersion}` : ''}${u.registryVersion ? ` → ${u.registryVersion}` : ''}`)
    .join(', ');
  return `${updates.length} plugin update${updates.length === 1 ? '' : 's'} available: ${list}. Run \`brainrouter plugin update --all\`.`;
}
