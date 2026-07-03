/**
 * PLUGIN-MARKETPLACE P1 — plugin storage locations (BrainRouter conventions).
 *
 * Plugins live in TWO scopes, resolved by the loader (plan §3.5):
 *   - USER      — `~/.brainrouter/plugins/<name>/`   (follows the user)
 *   - WORKSPACE — `<ws>/.brainrouter/plugins/<name>/` (committable, project-pinned)
 *
 * `BRAINROUTER_HOME` overrides `~/.brainrouter` (tests point it at a temp dir).
 * Never `.claude`.
 */
import os from 'node:os';
import path from 'node:path';

export type PluginScope = 'user' | 'workspace';

/** User-global brainrouter home (`~/.brainrouter`, or `$BRAINROUTER_HOME`). Non-mutating. */
export function brainrouterHome(): string {
  const override = process.env.BRAINROUTER_HOME?.trim();
  return override || path.join(os.homedir(), '.brainrouter');
}

/** User-scope plugins dir: `~/.brainrouter/plugins`. */
export function userPluginsDir(): string {
  return path.join(brainrouterHome(), 'plugins');
}

/** Workspace-scope plugins dir: `<ws>/.brainrouter/plugins`. */
export function workspacePluginsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.brainrouter', 'plugins');
}

/** The plugins dir for a scope. */
export function pluginsDirForScope(scope: PluginScope, workspaceRoot: string): string {
  return scope === 'workspace' ? workspacePluginsDir(workspaceRoot) : userPluginsDir();
}

/** Installed-plugin root for a given scope + name. */
export function pluginInstallRoot(scope: PluginScope, name: string, workspaceRoot: string): string {
  return path.join(pluginsDirForScope(scope, workspaceRoot), name);
}

/** Atomic-staging dir (user scope): `~/.brainrouter/plugins/.staging`. */
export function stagingDir(): string {
  return path.join(userPluginsDir(), '.staging');
}

/** Records where an installed plugin came from — written as `install.json`. */
export interface PluginInstallRecord {
  source: string;
  sourceType: 'local' | 'git' | 'http';
  ref?: string;
  revision?: string;
  installedAt: string;
  scope: PluginScope;
  /** PLUGIN-MARKETPLACE P2 — sub-path inside the fetched source (monorepo). */
  subPath?: string;
  /** PLUGIN-MARKETPLACE P2 — the marketplace name this plugin was resolved from
   *  (install-by-name); absent for a direct path/git install. */
  marketplace?: string;
}

export const INSTALL_RECORD_FILE = 'install.json';
