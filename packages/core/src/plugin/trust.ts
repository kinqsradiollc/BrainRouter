/**
 * PLUGIN-MARKETPLACE P3 — trust / consent / managed gating (plan §3.7/§4).
 *
 * Three concerns, all PURE (no side effects — trivially testable):
 *
 * 1. CONSENT / DISCLOSURE — before ENABLING a freshly-installed plugin, produce a
 *    capability summary ("3 skills, 2 hooks running `<cmd>`, 1 MCP server running
 *    `<cmd>`, …") and a `requiresConsent` flag. Executable capabilities (command
 *    hooks + MCP command-servers) stay DISABLED until the user approves them via
 *    `cli.plugins.approved[name].{shell,mcp}` — wired through the SAME two-axis
 *    exec policy the agent already uses (this module decides whether the
 *    contribution is even registered; the exec policy gates the runtime call).
 *
 * 2. MANAGED GATING — `allowedMarketplaces` / `blockedMarketplaces` reject a
 *    marketplace; `allowManagedHooksOnly` refuses a plugin's hooks outright
 *    (mirrors the `availableModels` / `enforce` pattern).
 *
 * 3. COMPATIBILITY — warn (never hard-fail) when a manifest's
 *    `compatibility.brainrouterVersion` / `agentApiVersion` doesn't satisfy the
 *    running version, reusing `checkVersionRange`.
 */
import fs from 'node:fs';
import { checkVersionRange } from '../provider/modelPolicy.js';
import { expandPluginRoot, type PluginManifest } from './manifest.js';
import { summarizeProvides, type DiscoveredPlugin, type PluginProvides } from './discovery.js';

/** The current agent API version this build implements. */
export const AGENT_API_VERSION = '1';

// ---------------------------------------------------------------------------
// Consent / disclosure summary
// ---------------------------------------------------------------------------

/** A risky command surfaced in the consent disclosure. */
export interface CapabilityCommand {
  /** For a hook: the event/matcher it fires on; for MCP: the server id. */
  label: string;
  /** The shell command / MCP run command (`${BRAINROUTER_PLUGIN_ROOT}` expanded). */
  command: string;
  /** hook `type` (`command` vs `prompt`) — a prompt hook is not shell-risky. */
  kind?: string;
}

export interface ConsentSummary {
  name: string;
  version?: string;
  provides: PluginProvides;
  /** The shell commands the plugin's command-type hooks would run. */
  hookCommands: CapabilityCommand[];
  /** The run commands the plugin's MCP command-servers would launch. */
  mcpCommands: CapabilityCommand[];
  /** True when the plugin ships an executable (shell/MCP) capability that needs
   *  explicit approval before it will load. */
  requiresConsent: boolean;
  /** Whether the risky capabilities are already approved in config. */
  shellApproved: boolean;
  mcpApproved: boolean;
  /** Compatibility warnings (empty when compatible). */
  compatibilityWarnings: string[];
  /** A one-line human summary (for the CLI prompt / desktop dialog). */
  disclosure: string;
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Extract the shell commands a plugin's hooks.json would run (command-type only). */
function extractHookCommands(hooksFile: string, pluginRoot: string): CapabilityCommand[] {
  const raw = readJson(hooksFile);
  const out: CapabilityCommand[] = [];
  const visit = (h: unknown, label: string): void => {
    if (!h || typeof h !== 'object' || Array.isArray(h)) return;
    const obj = h as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type : undefined;
    const command = typeof obj.command === 'string' ? obj.command : undefined;
    if (command && (type === undefined || type === 'command')) {
      out.push({ label, command: expandPluginRoot(command, pluginRoot), kind: type ?? 'command' });
    }
  };
  const walkList = (list: unknown[], eventLabel: string): void => {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      // { matcher, hooks: [ { type, command } ] } shape
      if (Array.isArray(rec.hooks)) {
        const matcher = typeof rec.matcher === 'string' && rec.matcher ? `${eventLabel}:${rec.matcher}` : eventLabel;
        for (const inner of rec.hooks) visit(inner, matcher);
      } else {
        visit(rec, eventLabel);
      }
    }
  };
  if (Array.isArray(raw)) {
    walkList(raw, 'hook');
  } else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (Array.isArray(rec.hooks)) {
      walkList(rec.hooks, 'hook');
    } else {
      // { <event>: [ ... ] } shape (Claude-style hook events)
      for (const [event, val] of Object.entries(rec)) {
        if (Array.isArray(val)) walkList(val, event);
      }
    }
  }
  return out;
}

/** Extract the run commands a plugin's mcp.json command-servers would launch. */
function extractMcpCommands(mcpFile: string, pluginRoot: string): CapabilityCommand[] {
  const raw = readJson(mcpFile);
  const servers = (raw && typeof raw === 'object' && (raw as { mcpServers?: unknown }).mcpServers) || raw;
  const out: CapabilityCommand[] = [];
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return out;
  for (const [id, cfg] of Object.entries(servers as Record<string, unknown>)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const rec = cfg as Record<string, unknown>;
    const command = typeof rec.command === 'string' ? rec.command : undefined;
    // A command-server is the risky kind (vs a url/http server).
    if (command) {
      const args = Array.isArray(rec.args) ? rec.args.filter((a) => typeof a === 'string').map(String) : [];
      const full = [command, ...args].join(' ');
      out.push({ label: id, command: expandPluginRoot(full, pluginRoot) });
    }
  }
  return out;
}

/** Compatibility check against the running BrainRouter + agent API version. */
export function checkCompatibility(
  manifest: PluginManifest,
  runtime: { brainrouterVersion: string; agentApiVersion?: string },
): string[] {
  const warnings: string[] = [];
  const compat = manifest.compatibility;
  if (!compat) return warnings;
  if (compat.brainrouterVersion) {
    const { min, max, ok: parsed } = parseVersionExpr(compat.brainrouterVersion);
    if (!parsed) {
      warnings.push(`compatibility.brainrouterVersion "${compat.brainrouterVersion}" is not a recognized range`);
    } else {
      const range = checkVersionRange(runtime.brainrouterVersion, min, max);
      if (!range.ok && range.message) warnings.push(range.message);
    }
  }
  if (compat.agentApiVersion) {
    const want = compat.agentApiVersion.trim();
    const have = (runtime.agentApiVersion ?? AGENT_API_VERSION).trim();
    if (want !== have) {
      warnings.push(`plugin targets agentApiVersion "${want}" but this build is "${have}"`);
    }
  }
  return warnings;
}

/**
 * Parse a version expression into min/max bounds for `checkVersionRange`.
 * Supports: `>=x`, `>x`, `<=x`, `<x`, `x` (exact-ish → min=x), and a bare
 * `x - y` range. Anything unrecognized → `ok:false`.
 */
export function parseVersionExpr(expr: string): { min?: string; max?: string; ok: boolean } {
  const s = expr.trim();
  if (!s) return { ok: false };
  const range = s.match(/^([\d.]+)\s*-\s*([\d.]+)$/);
  if (range) return { min: range[1], max: range[2], ok: true };
  const m = s.match(/^(>=|<=|>|<|\^|~|=)?\s*v?([\d.]+)/);
  if (!m) return { ok: false };
  const op = m[1] ?? '>=';
  const ver = m[2];
  switch (op) {
    case '>=':
    case '>':
    case '^':
    case '~':
    case '=':
      return { min: ver, ok: true };
    case '<=':
    case '<':
      return { max: ver, ok: true };
    default:
      return { min: ver, ok: true };
  }
}

/**
 * Build the consent / disclosure summary for a discovered plugin. `approved` is
 * the plugin's entry from `cli.plugins.approved` (may be undefined = not yet
 * consented). `runtime` supplies the version for the compatibility check.
 */
export function buildConsentSummary(
  plugin: DiscoveredPlugin,
  opts: {
    approved?: { shell?: boolean; mcp?: boolean };
    runtime: { brainrouterVersion: string; agentApiVersion?: string };
  },
): ConsentSummary {
  const provides = summarizeProvides(plugin);
  const hookCommands = plugin.contributes.hooks ? extractHookCommands(plugin.contributes.hooks, plugin.root) : [];
  const mcpCommands = plugin.contributes.mcpServers ? extractMcpCommands(plugin.contributes.mcpServers, plugin.root) : [];
  const requiresConsent = hookCommands.length > 0 || mcpCommands.length > 0;
  const compatibilityWarnings = checkCompatibility(plugin.manifest, opts.runtime);

  const parts: string[] = [];
  const push = (n: number, one: string, many = `${one}s`): void => { if (n) parts.push(`${n} ${n === 1 ? one : many}`); };
  push(provides.skills, 'skill');
  push(provides.agents, 'agent');
  push(provides.commands, 'command');
  push(provides.hooks, 'hook');
  push(provides.mcpServers, 'MCP server');
  push(provides.connectors, 'connector');
  push(provides.workflows, 'workflow');
  let disclosure = `${plugin.name}${plugin.manifest.version ? ` v${plugin.manifest.version}` : ''} provides ${parts.length ? parts.join(', ') : 'nothing'}.`;
  if (hookCommands.length) disclosure += ` Hooks run: ${hookCommands.map((h) => `\`${h.command}\``).join('; ')}.`;
  if (mcpCommands.length) disclosure += ` MCP servers run: ${mcpCommands.map((m) => `\`${m.command}\``).join('; ')}.`;

  return {
    name: plugin.name,
    version: plugin.manifest.version,
    provides,
    hookCommands,
    mcpCommands,
    requiresConsent,
    shellApproved: opts.approved?.shell === true,
    mcpApproved: opts.approved?.mcp === true,
    compatibilityWarnings,
    disclosure,
  };
}

// ---------------------------------------------------------------------------
// Managed gating — allowed / blocked marketplaces, allowManagedHooksOnly
// ---------------------------------------------------------------------------

export interface ManagedGates {
  allowedMarketplaces: readonly string[];
  blockedMarketplaces: readonly string[];
  allowManagedHooksOnly: boolean;
}

/**
 * Decide whether a marketplace NAME is permitted under the managed gates. A
 * blocklist match always refuses; a non-empty allowlist refuses anything not on
 * it (mirrors `isModelAllowed` / `assertModelAllowed`). Returns an error message
 * when refused, else null.
 */
export function assertMarketplaceAllowed(name: string, gates: ManagedGates): string | null {
  const n = name.trim();
  const blocked = gates.blockedMarketplaces.map((m) => m.trim()).filter(Boolean);
  if (blocked.includes(n)) return `marketplace "${n}" is blocked by managed policy (blockedMarketplaces).`;
  const allowed = gates.allowedMarketplaces.map((m) => m.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(n)) {
    return `marketplace "${n}" is not in the managed allowlist (allowedMarketplaces: [${allowed.join(', ')}]).`;
  }
  return null;
}

/** True when a plugin's HOOK contributions may load under the managed gate. When
 *  `allowManagedHooksOnly` is on, third-party plugin hooks are refused. */
export function hooksAllowed(gates: Pick<ManagedGates, 'allowManagedHooksOnly'>): boolean {
  return !gates.allowManagedHooksOnly;
}

/** Whether a plugin's command hooks are permitted to load: needs BOTH the
 *  managed gate open AND the per-plugin shell capability approved. */
export function commandHooksEnabled(
  gates: Pick<ManagedGates, 'allowManagedHooksOnly'>,
  approved: { shell?: boolean } | undefined,
): boolean {
  return hooksAllowed(gates) && approved?.shell === true;
}

/** Whether a plugin's MCP command-servers are permitted to load: needs the
 *  per-plugin mcp capability approved. */
export function mcpServersEnabled(approved: { mcp?: boolean } | undefined): boolean {
  return approved?.mcp === true;
}
