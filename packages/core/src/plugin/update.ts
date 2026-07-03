/**
 * PLUGIN-MARKETPLACE P5 — `brainrouter plugin update [name|--all]` (plan §4/P5).
 *
 * Re-resolve an installed plugin's ORIGINAL source (from its `install.json`), and
 * if a newer version/revision exists, atomic-restage + swap it into place while
 * PRESERVING enabled state + capability consent (the config's `enabled` /
 * `approved` maps are keyed by name and untouched by a re-install). Reuses P1's
 * atomic `installPlugin` (staging → validate → rename), so a failed update leaves
 * the live copy intact.
 *
 * "Newer" is decided by:
 *   - git source → the freshly-cloned HEAD revision differs from the recorded one;
 *   - local / marketplace source → the re-discovered manifest `version` differs
 *     from the installed manifest `version` (a local dir is always re-copied so a
 *     content change is picked up even at the same version).
 *
 * BrainRouter conventions only — never `.claude`.
 */
import { pluginInstallRoot, type PluginScope } from './paths.js';
import { discoverPlugin } from './discovery.js';
import { readInstallRecord } from './install.js';
import { installPlugin, type InstallResult } from './install.js';
import { installPluginByName } from './marketplace.js';
import type { Config } from '../config/configTypes.js';
import { loadOrInitConfig } from '../config/config.js';
import { listInstalledPlugins } from './installed.js';

export interface UpdateResult {
  ok: boolean;
  name: string;
  scope: PluginScope;
  /** True when a new revision/version was staged + swapped in. */
  updated: boolean;
  fromVersion?: string;
  toVersion?: string;
  fromRevision?: string;
  toRevision?: string;
  error?: string;
}

/**
 * Update ONE installed plugin by name in a given scope. Re-resolves its source
 * from `install.json`. Enabled/consent state is preserved automatically (config
 * maps are name-keyed and never rewritten here). `config` is only consulted for
 * marketplace-sourced plugins (install-by-name resolution).
 */
export function updatePlugin(
  name: string,
  opts: { scope?: PluginScope; workspaceRoot?: string; config?: Config } = {},
): UpdateResult {
  const scope = opts.scope ?? 'user';
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const root = pluginInstallRoot(scope, name, workspaceRoot);

  const before = discoverPlugin(root);
  if (!before.ok) return { ok: false, name, scope, updated: false, error: `plugin "${name}" not installed in ${scope} scope` };
  const record = readInstallRecord(root);
  if (!record) return { ok: false, name, scope, updated: false, error: `plugin "${name}" has no install.json — re-install it to enable updates` };

  const fromVersion = before.plugin.manifest.version;
  const fromRevision = record.revision;

  // Re-run the ORIGINAL install path (force-overwrites the live copy atomically).
  let result: InstallResult;
  if (record.marketplace) {
    const r = installPluginByName(name, { scope, workspaceRoot, force: true, config: opts.config });
    if (!r.ok || !r.result) return { ok: false, name, scope, updated: false, fromVersion, fromRevision, error: r.error ?? 'update failed' };
    result = r.result;
  } else {
    result = installPlugin(record.source, {
      scope,
      workspaceRoot,
      force: true,
      ref: record.ref,
      subPath: record.subPath,
      marketplace: record.marketplace,
    });
  }
  if (!result.ok) return { ok: false, name, scope, updated: false, fromVersion, fromRevision, error: result.error };

  const toVersion = result.manifest.version;
  const toRevision = result.record.revision;
  // Decide whether anything actually changed: a git revision bump, or a version
  // bump (local sources may re-copy identical content — report updated only on a
  // detectable version/revision delta).
  const revisionChanged = !!(toRevision && toRevision !== fromRevision);
  const versionChanged = !!(toVersion && toVersion !== fromVersion);
  const updated = revisionChanged || versionChanged;

  return { ok: true, name, scope, updated, fromVersion, toVersion, fromRevision, toRevision };
}

/**
 * Update ALL installed plugins across both scopes (or a single named one). Reads
 * config once for marketplace resolution. Enabled/consent state is preserved.
 */
export function updatePlugins(
  opts: { name?: string; workspaceRoot?: string; config?: Config } = {},
): UpdateResult[] {
  const workspaceRoot = opts.workspaceRoot ?? process.cwd();
  const config = opts.config ?? loadOrInitConfig();
  const installed = listInstalledPlugins(workspaceRoot);
  const targets = opts.name
    ? installed.filter((p) => p.name === opts.name)
    : installed;
  const results: UpdateResult[] = [];
  for (const p of targets) {
    results.push(updatePlugin(p.name, { scope: p.scope, workspaceRoot, config }));
  }
  if (opts.name && targets.length === 0) {
    results.push({ ok: false, name: opts.name, scope: 'user', updated: false, error: `plugin "${opts.name}" is not installed` });
  }
  return results;
}
