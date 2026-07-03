/**
 * PLUGIN-MARKETPLACE P1 — enable/disable state mutation over `config.json`.
 *
 * Enable/disable is stored in `cli.plugins.enabled` (plan §3.5). These helpers
 * mutate a Config object + persist it, so the CLI `plugin enable/disable`
 * commands and the desktop toggles share one implementation.
 */
import { loadOrInitConfig, saveConfig } from '../config/config.js';
import type { Config } from '../config/configTypes.js';

/** Set a plugin's enabled flag in `cli.plugins.enabled`, returning the mutated config. */
export function setPluginEnabledIn(config: Config, name: string, enabled: boolean): Config {
  const cli = config.cli ?? {};
  const plugins = cli.plugins ?? {};
  const map = { ...(plugins.enabled ?? {}) };
  map[name] = enabled;
  return { ...config, cli: { ...cli, plugins: { ...plugins, enabled: map } } };
}

/** Load config (or an empty skeleton on first run), flip a plugin's enabled flag,
 *  and persist. Returns the new config. Uses `loadOrInitConfig` so enabling a
 *  plugin never hard-exits just because no config.json exists yet. */
export function setPluginEnabled(name: string, enabled: boolean): Config {
  const next = setPluginEnabledIn(loadOrInitConfig(), name, enabled);
  saveConfig(next);
  return next;
}

/** True when a plugin is enabled in the given config (default false). */
export function isPluginEnabled(config: Config, name: string): boolean {
  return config.cli?.plugins?.enabled?.[name] === true;
}
