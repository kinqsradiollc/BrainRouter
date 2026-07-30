/**
 * PLUGIN-MARKETPLACE P1 — enable/disable state mutation over `config.json`.
 *
 * Enable/disable is stored in `cli.plugins.enabled` (plan §3.5). These helpers
 * mutate a Config object + persist it, so the CLI `plugin enable/disable`
 * commands and the desktop toggles share one implementation.
 */
import { loadOrInitConfig, saveConfig } from '../config/config.js';
import type { Config, PluginCapabilityConsent } from '../config/configTypes.js';

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

/**
 * PLUGIN-MARKETPLACE P3 — record the user's consent to a plugin's risky
 * (shell / MCP) capabilities in `cli.plugins.approved[name]`. Merges into any
 * existing consent; passing `{ shell: false }` revokes shell. Returns the
 * mutated config (pure — the caller persists).
 */
export function setPluginConsentIn(config: Config, name: string, consent: PluginCapabilityConsent): Config {
  const cli = config.cli ?? {};
  const plugins = cli.plugins ?? {};
  const approved = { ...(plugins.approved ?? {}) };
  const prev = approved[name] ?? {};
  const next: PluginCapabilityConsent = { ...prev };
  if (consent.shell !== undefined) next.shell = consent.shell;
  if (consent.mcp !== undefined) next.mcp = consent.mcp;
  // Drop the entry entirely when nothing is consented (keeps config tidy).
  if (!next.shell && !next.mcp) delete approved[name];
  else approved[name] = next;
  return { ...config, cli: { ...cli, plugins: { ...plugins, approved } } };
}

/** Load config, record a plugin's capability consent, and persist. */
export function setPluginConsent(name: string, consent: PluginCapabilityConsent): Config {
  const next = setPluginConsentIn(loadOrInitConfig(), name, consent);
  saveConfig(next);
  return next;
}

/** The consented capabilities for a plugin (default none). */
export function pluginConsent(config: Config, name: string): PluginCapabilityConsent {
  return config.cli?.plugins?.approved?.[name] ?? {};
}
