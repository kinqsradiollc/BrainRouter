/**
 * Shared types, constants, and pure helpers for the Settings modal. Extracted
 * from settings.tsx so each section component can import the same contracts
 * without a cycle back through the composed shell.
 */
import type { SettingsSection } from '../../lib/commands/commands.js';
import type { ConnectorCatalogEntry, ConnectorRecord, ConnectorRunRecord } from '@kinqs/brainrouter-types';
import type { ConfigSchemaDescriptor } from '@kinqs/brainrouter-core/config';

export interface ConnectorSlimPreview {
  id: string;
  kind: string;
  repository?: string;
  title: string;
  snippet: string;
}

export interface ConfigSnapshot {
  model?: string;
  provider?: string;
  endpoint?: string | null;
  fallbackModel?: string | null;
  workspaceRoot?: string;
  sandbox?: 'on' | 'off';
  prefs?: Record<string, unknown>;
  workspacePrefs?: Record<string, unknown>;
  sessionMode?: Record<string, unknown>;
  modeScope?: 'session' | 'workspace';
  cli?: Record<string, unknown>;
  integrations?: { github?: GithubIntegrationSnapshot };
  connectors?: { catalog: ConnectorCatalogEntry[]; items: ConnectorRecord[]; documentCounts?: Record<string, number>; permissionCounts?: Record<string, number>; runPreviews?: Record<string, ConnectorRunRecord[]>; documentPreviews?: Record<string, ConnectorSlimPreview[]> };
  permissionRules?: { allow: string[]; deny: string[] };
  hooks?: Array<{ id: string; event: string; command: string; enabled: boolean; match?: string }>;
  servers?: Array<{ id: string; online: boolean; identity?: string; detail?: string; type?: 'stdio' | 'http'; url?: string | null; command?: string | null; hasKey?: boolean; envCount?: number; headerCount?: number }>;
  activeServer?: string | null; // WS9 — the active BrainRouter brain (only one)
  // §multi-provider — named OpenAI-compatible providers (keys masked) + per-role routing.
  providers?: Array<{ name: string; provider: string; model: string; endpoint: string | null; hasKey: boolean; models?: string[]; apiVersion?: string | null }>;
  defaultProviderName?: string | null;
  defaultProviderModelMatches?: boolean;
  agentModels?: Array<{ role: string; provider: string | null; model: string | null }>;
  // Known-provider catalog (the CLI wizard's list) so the main provider is PICKED.
  providerCatalog?: Array<{ id: string; label: string; endpoint: string; local: boolean }>;
  // §settings-completeness — the raw cli.* config block (current knob values).
  cliKnobs?: Record<string, unknown>;
  cliSchema?: ConfigSchemaDescriptor;
  // MC-B1 — write-only trigger signing secrets: the renderer only learns which
  // are set (the value is scrubbed from cliKnobs), so the Automations panel can
  // show "configured" without ever holding the secret.
  triggerSecretsSet?: { github: boolean; slack: boolean; gitlab: boolean; jira: boolean };
  // EXTENSIONS — discovered extensions + workspace trust state.
  extensions?: {
    trusted: boolean;
    items: Array<{ name: string; version: string; source: 'builtin' | 'user' | 'workspace'; description: string; contributes: string[]; enabled: boolean; blocked: boolean }>;
  };
}

export interface GithubRepoSnapshot {
  repo: string;
  hasToken: boolean;
  tokenSource: string | null;
  active?: boolean;
  label?: string | null;
}

export interface GithubIntegrationSnapshot {
  repo: string | null;
  hasToken: boolean;
  tokenSource: string | null;
  repos?: GithubRepoSnapshot[];
  caBundle?: string | null;
}

export type GithubSaveArgs = {
  repo?: string;
  token?: string;
  clearToken?: boolean;
  makeActive?: boolean;
  removeRepo?: string;
  caBundle?: string | null;
};

/** Sub-agent roles that can be routed to their own provider/model. */
export const SUBAGENT_ROLES = ['default', 'explorer', 'architect', 'reviewer', 'worker', 'verifier'] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];
export const WIRE_FORMAT_OPTIONS = ['default', 'chat-completions', 'responses'] as const;
export type WireFormatOption = (typeof WIRE_FORMAT_OPTIONS)[number];
export type WireFormatOverride = Exclude<WireFormatOption, 'default'>;

export function normalizeProviderId(id?: string | null): string {
  return (id ?? '').trim().toLowerCase();
}

export function normalizeWireFormatOverrides(value: unknown): Record<string, WireFormatOverride> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, WireFormatOverride> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeProviderId(rawKey);
    if (!key) continue;
    if (rawValue === 'responses' || rawValue === 'chat-completions') out[key] = rawValue;
  }
  return out;
}

export const SUBAGENT_ROLE_LABELS: Record<SubagentRole, string> = {
  default: 'Fallback for sub-agents',
  explorer: 'explorer',
  architect: 'architect',
  reviewer: 'reviewer',
  worker: 'worker',
  verifier: 'verifier',
};

export const NAV: Array<{ section: SettingsSection; icon: string; title: string; group: 'Settings' | 'Desktop app' }> = [
  { section: 'general', icon: 'gear', title: 'General', group: 'Settings' },
  { section: 'models', icon: 'spark', title: 'Models', group: 'Settings' },
  { section: 'permissions', icon: 'shield', title: 'Permissions', group: 'Settings' },
  { section: 'memory', icon: 'brain', title: 'Memory', group: 'Settings' },
  { section: 'hooks', icon: 'link', title: 'Hooks', group: 'Settings' },
  { section: 'workflow-automation', icon: 'fork', title: 'Workflow automation', group: 'Settings' },
  { section: 'runtime', icon: 'terminal', title: 'Runtime', group: 'Settings' },
  { section: 'automations', icon: 'globe', title: 'Automations', group: 'Settings' },
  { section: 'extensions', icon: 'plug', title: 'Extensions', group: 'Settings' },
  { section: 'connectors', icon: 'bolt', title: 'MCP Servers', group: 'Settings' },
  { section: 'tools', icon: 'gear', title: 'Tools', group: 'Settings' },
  { section: 'data-connectors', icon: 'branch', title: 'Connectors', group: 'Settings' },
  { section: 'marketplace', icon: 'plug', title: 'Marketplace', group: 'Settings' },
  { section: 'advanced', icon: 'gear', title: 'Advanced', group: 'Settings' },
  { section: 'observability', icon: 'chart', title: 'Usage', group: 'Settings' },
  { section: 'appearance', icon: 'palette', title: 'Appearance', group: 'Desktop app' },
  { section: 'commands', icon: 'command', title: 'Commands', group: 'Desktop app' },
];

// WS11 — knobs that have a dedicated structured editor elsewhere (Permissions,
// Workflow automation, Models, Connectors). Never shown as raw JSON here.
export const DEDICATED_KNOBS = new Set(['permissions', 'automation', 'track', 'github', 'providers', 'agentModels', 'providerRequestFormat',
  // MC-DESK — object-knobs now driven by their own structured Settings panels
  // (Runtime / Automations / Profiles), so they never appear as raw JSON rows.
  'runtime', 'triggers', 'critic', 'budget', 'agents', 'llmProfiles']);
// WS11 — internal/safety knobs (loop & storm guards, sandbox internals, scheduler
// ticks, offload tuning): non-obvious to hand-edit and rarely needed, so hidden
// from the default list. Still settable via `/config` or the raw disclosure.
export const INTERNAL_KNOBS = new Set([
  'stormWindow', 'repeatToolSequenceLimit', 'repeatSequenceExemptTools', 'repeatLoopLimit',
  'offloadMaxEntries', 'offloadRetentionMs', 'scheduleTickMs',
  'sandboxReadPaths', 'sandboxWritePaths', 'sandboxNetwork', 'sandboxUnavailable', 'sandboxEnforceWhenSilent',
]);

export type ChoiceOption = { value: string; label: string; detail?: string; disabled?: boolean };

export function connectorConfigString(connector: ConnectorRecord, key: string): string {
  const value = connector.config[key];
  return typeof value === 'string' ? value : '';
}

export function connectorConfigList(connector: ConnectorRecord, key: string): string[] {
  const value = connector.config[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function splitConnectorRepos(value: string): string[] {
  return value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

export const CHECKPOINT_RUNTIME_SOURCES = new Set<ConnectorRecord['source']>([
  'github',
  'filesystem',
  'web',
  'gitlab',
  'slack',
  'jira',
  'confluence',
  'notion',
  'linear',
  'mcp',
  'google-drive',
  'gmail',
]);

export type GithubOauthState =
  | { status: 'idle'; hasToken?: boolean; storageMode?: string }
  | { status: 'starting' }
  | { status: 'pending'; userCode: string; verificationUri: string; intervalSec: number; expiresAtMs: number }
  | { status: 'authorized'; scope?: string; storageMode?: string }
  | { status: 'error'; error: string };

export interface GithubOrgRow {
  login: string;
  description?: string;
}

export interface GithubRepoRow {
  nameWithOwner: string;
  isPrivate?: boolean;
  isArchived?: boolean;
  isFork?: boolean;
  description?: string;
  pushedAt?: string;
}

export interface GithubOrgsResult {
  viewer?: { login?: string } | null;
  orgs?: GithubOrgRow[];
  errors?: string[];
}

export interface GithubReposResult {
  repos?: GithubRepoRow[];
  nextPage?: number | null;
  rateLimited?: boolean;
  errors?: string[];
}

/** WS10 — cross-session usage tally for the contributions heatmap. Shape mirrors
 *  the host `usage-history` query ({ days, total }). */
export interface UsageHistory {
  days: Array<{ day: string; promptTokens: number; completionTokens: number; calls: number; turns: number }>;
  total: { promptTokens: number; completionTokens: number; calls: number; turns: number };
}
