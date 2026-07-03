/**
 * PLUGIN-MARKETPLACE P5 — enumerate INSTALLED plugins across both scopes.
 *
 * Shared by `plugin update --all` and the auto-update check. Scans the user +
 * workspace plugin dirs, discovers each valid plugin, and returns its name +
 * scope + manifest version + install record. Invalid dirs are skipped silently
 * (the loader surfaces those errors elsewhere). Never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pluginsDirForScope, type PluginScope, type PluginInstallRecord } from './paths.js';
import { discoverPlugin, looksLikePlugin } from './discovery.js';
import { readInstallRecord } from './install.js';

export interface InstalledPlugin {
  name: string;
  scope: PluginScope;
  root: string;
  version?: string;
  record?: PluginInstallRecord;
}

function pluginDirsIn(dir: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || !e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    if (looksLikePlugin(full)) out.push(full);
  }
  return out;
}

/**
 * List installed plugins across user + workspace scopes. When the same name
 * exists in both, WORKSPACE wins (mirrors the loader's precedence) — a project
 * pins its own copy, so an update targets the workspace one.
 */
export function listInstalledPlugins(workspaceRoot: string): InstalledPlugin[] {
  const byName = new Map<string, InstalledPlugin>();
  for (const scope of ['user', 'workspace'] as PluginScope[]) {
    const dir = pluginsDirForScope(scope, workspaceRoot);
    for (const root of pluginDirsIn(dir)) {
      const disc = discoverPlugin(root);
      if (!disc.ok) continue;
      byName.set(disc.plugin.name, {
        name: disc.plugin.name,
        scope,
        root,
        version: disc.plugin.manifest.version,
        record: readInstallRecord(root),
      });
    }
  }
  return [...byName.values()];
}
