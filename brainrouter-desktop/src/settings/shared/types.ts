/**
 * Shared types, constants, and pure helpers for the Settings modal. Extracted
 * from settings.tsx so each section component can import the same contracts
 * without a cycle back through the composed shell.
 */
import type { SettingsSection } from '../../lib/commands/commands.js';
import type { ConnectorCatalogEntry, ConnectorRecord, ConnectorRunRecord, ModelPolicy } from '@kinqs/brainrouter-types';
import type { ConfigSchemaDescriptor } from '@kinqs/brainrouter-core/config';
import type { LearnedItem, LearnedTenant, LearningLogEntry } from '@kinqs/brainrouter-core/learning';

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
  accountModels?: {
    signedIn: boolean;
    provider: { id: 'brainrouter'; label: 'BrainRouter'; readOnly: true };
    revision: string | null;
    etag: string | null;
    models: ModelPolicy[];
    stale: boolean;
    refreshedAt: string | null;
    error?: string;
  };
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
  providers?: Array<{
    name: string;
    provider: string;
    model: string;
    endpoint: string | null;
    hasKey: boolean;
    models?: string[];
    cachedModels?: string[];
    cachedAt?: string | null;
    apiVersion?: string | null;
    free?: boolean;
    passthroughUnknown?: boolean;
  }>;
  routerCatalog?: {
    enabled: boolean;
    primaryChain: string[];
    canonical: Array<{ id: string; model: string; slug?: string; providers: string[]; provider?: string; endpoint?: string; cachedAt?: string }>;
    bare: Array<{ id: string; model: string; providers: string[]; endpoint?: string; cachedAt?: string }>;
    aliases: Array<{ id: string; model: string; alias?: string; target?: string; providers: string[] }>;
  };
  routerStatus?: {
    providers: Array<{ provider: string; until: number; step: number; reason: string }>;
    models: Array<{ route: string; until: number; step: number; reason: string }>;
    recentEvents?: Array<{ at: number; message: string; from: string; to: string; reason: string; status?: number }>;
  };
  routerServe?: { running: boolean; host: string | null; port: number | null; startedAt: string | null; url: string | null; recentEvents: string[]; lastError: string | null };
  routerSecretsSet?: { serveKey: boolean };
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
  // MC-DESK Batch 2 — live runtime/automation monitor data (host-read).
  runtimes?: Array<{ id: string; backend: string; status: string; pid: number | null; worktree: string | null; createdAt: string; updatedAt: string }>;
  runtimeArchives?: Array<{ id: string; branch: string; baseCommit: string; bytes: number; changedFiles: number; status: string; createdAt: string; note: string | null; workspaceRoot: string }>;
  runtimePreviewsLive?: Array<{ runtimeId: string; name: string; url: string; port: number }>;
  automationRules?: Array<{ id: string; name: string; on: string; when: string; do: string; enabled: boolean; sourcePath: string }>;
  // MC-DESK — in-host trigger-ingress daemon status (Start/Stop from Automations).
  triggerServe?: { running: boolean; host: string | null; port: number | null; startedAt: string | null; providers: string[]; recentEvents: string[]; lastError: string | null };
  // EXTENSIONS — discovered extensions + workspace trust state.
  extensions?: {
    trusted: boolean;
    items: Array<{ name: string; version: string; source: 'builtin' | 'user' | 'workspace'; description: string; contributes: string[]; enabled: boolean; blocked: boolean }>;
  };
  /** ADR-032 Q4 — the exact tenant-scoped behavioural store that reaches the
   * agent, exposed read-only here except for explicit human correction/revert. */
  learning?: {
    tenant: LearnedTenant;
    items: LearnedItem[];
    log: LearningLogEntry[];
    correctionAllowed: boolean;
    correctionBlockedReason?: string;
    error?: string;
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

export type SettingsGroup = 'Account' | 'Agent' | 'Automation' | 'Connections' | 'System';

export interface SettingsNavItem {
  section: SettingsSection;
  icon: string;
  title: string;
  group: SettingsGroup;
  description: string;
  /** Search aliases mirror the controls inside each page without exposing a
   * second, easily-drifted list of individual setting rows in the shell. */
  keywords: string;
}

export const NAV_GROUPS: Array<{ group: SettingsGroup; icon: string; description: string }> = [
  { group: 'Account', icon: 'shield', description: 'Identity and defaults' },
  { group: 'Agent', icon: 'spark', description: 'Defaults, models, permissions, and memory' },
  { group: 'Automation', icon: 'bolt', description: 'Plans, routines, and reviews' },
  { group: 'Connections', icon: 'plug', description: 'Connected tools and add-ons' },
  { group: 'System', icon: 'gear', description: 'Usage, appearance, and controls' },
];

export const NAV: SettingsNavItem[] = [
  { section: 'account', icon: 'shield', title: 'Account', group: 'Account', description: 'Sign-in, organization, and devices', keywords: 'email password hosted memory teams sessions logout plan role organization id' },
  { section: 'general', icon: 'gear', title: 'General', group: 'Agent', description: 'Agent defaults and chat lifecycle', keywords: 'reasoning effort personality tier fast mode new chat compact clear history safe mode attribution provenance commits prs' },
  { section: 'models', icon: 'spark', title: 'Models', group: 'Agent', description: 'Providers, routes, and model profiles', keywords: 'api key endpoint provider openai anthropic azure ollama routing chain gateway sub-agent profiles wire format' },
  { section: 'permissions', icon: 'shield', title: 'Permissions', group: 'Agent', description: 'Approvals, sandbox, and computer use', keywords: 'execution review yolo delegation children auto-chain filesystem external writes allow deny rules shell access native screen accessibility' },
  { section: 'memory', icon: 'brain', title: 'Memory', group: 'Agent', description: 'Recall, briefing, and persona behavior', keywords: 'pipeline memories persona quiet mode brain forget export import blackboard consolidation' },
  { section: 'tools', icon: 'gear', title: 'Tools', group: 'Agent', description: 'Built-in and connected tool access', keywords: 'enable disable override protected mcp local model read edit run plan goal' },
  { section: 'workflow-automation', icon: 'fork', title: 'Auto-planning', group: 'Automation', description: 'Requirements, plans, and sprint flow', keywords: 'autopilot propose detect requirements sync track reconcile sprints stages' },
  { section: 'runtime', icon: 'terminal', title: 'Runtime', group: 'Automation', description: 'Execution backends, isolated runs, and preview port defaults', keywords: 'execution backend comprehension understand review questions container host worktree archive jit secrets serve remote runtime preview port reservations budget critic hosted cli agents design hook detector findings tells' },
  { section: 'automations', icon: 'globe', title: 'Automations', group: 'Automation', description: 'Inbound triggers, webhooks, and jobs', keywords: 'github slack gitlab jira signing secret listener daemon rules allowed repos' },
  { section: 'reviews', icon: 'shield', title: 'PR reviews', group: 'Automation', description: 'Automated GitHub review behavior', keywords: 'security code review findings branch protection push repositories app installation webhook' },
  { section: 'hooks', icon: 'link', title: 'Hooks', group: 'Automation', description: 'Agent lifecycle hook commands', keywords: 'session start stop turn tool command scripts timeout lifecycle' },
  { section: 'connectors', icon: 'bolt', title: 'MCP servers', group: 'Connections', description: 'Model Context Protocol servers', keywords: 'brain tools stdio http url command environment env enabled disabled' },
  { section: 'data-connectors', icon: 'branch', title: 'Connectors', group: 'Connections', description: 'Knowledge and repository sources', keywords: 'github gitlab slack jira confluence notion linear google drive gmail filesystem web sync checkpoint oauth' },
  { section: 'repositories', icon: 'branch', title: 'Repositories', group: 'Connections', description: 'Link this repo to memory and index it', keywords: 'github repo memory index repotag remote origin scope ingest files checkout clone identity' },
  { section: 'extensions', icon: 'plug', title: 'Extensions', group: 'Connections', description: 'Workspace add-ons, trust, and skills', keywords: 'discover enable disable bundled keyword triggers stack org convention repo' },
  { section: 'marketplace', icon: 'plug', title: 'Marketplace', group: 'Connections', description: 'Find and manage plugins', keywords: 'install update registry publish manifest organization scope source community' },
  { section: 'observability', icon: 'chart', title: 'Usage', group: 'System', description: 'Tokens, activity, and diagnostics', keywords: 'heatmap week month year telemetry workspace doctor debug trace latency calls turns' },
  { section: 'appearance', icon: 'palette', title: 'Appearance', group: 'System', description: 'Theme, typography, and transcript layout', keywords: 'accent color desktop theme graphite mono high contrast dark code font transcript width transcript text size terminal cli markdown theme raw scrollback vi composer vim experimental features' },
  { section: 'commands', icon: 'command', title: 'Commands', group: 'System', description: 'Slash-command reference and launcher', keywords: 'catalog native panel settings cli run palette shortcuts' },
  { section: 'advanced', icon: 'gear', title: 'Advanced', group: 'System', description: 'Technical and raw CLI configuration', keywords: 'model limits agents notifications github oauth client keyboard shortcuts config json schema developer cli knobs' },
];

export function settingsGroupForSection(section: SettingsSection): SettingsGroup {
  return NAV.find((item) => item.section === section)?.group ?? 'Account';
}

export function settingsSectionForGroup(group: SettingsGroup, remembered?: SettingsSection): SettingsSection {
  if (remembered && NAV.some((item) => item.group === group && item.section === remembered)) return remembered;
  return NAV.find((item) => item.group === group)?.section ?? 'general';
}

/** Search settings pages (not slash commands). All whitespace-separated terms
 * must match the page's title, summary, category, or control aliases. */
export function searchSettings(query: string): SettingsNavItem[] {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return NAV.filter((item) => {
    const haystack = normalize(`${item.title} ${item.description} ${item.group} ${item.keywords}`);
    return terms.every((term) => haystack.includes(term));
  });
}

// WS11 — knobs that have a dedicated structured editor elsewhere (Permissions,
// Workflow automation, Models, Connectors). Never shown as raw JSON here.
export const DEDICATED_KNOBS = new Set(['permissions', 'automation', 'track', 'github', 'providers', 'agentModels', 'providerRequestFormat',
  // MC-DESK — object-knobs now driven by their own structured Settings panels
  // (Runtime / Automations / Profiles), so they never appear as raw JSON rows.
  'runtime', 'triggers', 'critic', 'budget', 'agents', 'llmProfiles', 'router',
  // ADR-045 M2 — per-model context-window overrides get their own editor
  // (Models → Profiles → Context windows), so no raw JSON row.
  'contextWindows',
  // ADR-056 D-B2 — the design hook has its own row (Runtime → Design hook).
  'design']);
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
  | { status: 'pending'; flow: 'browser' | 'device'; userCode?: string; verificationUri?: string; intervalSec: number; expiresAtMs: number }
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
