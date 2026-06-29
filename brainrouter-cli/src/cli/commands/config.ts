import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { getConfigPath, getCliKnobs, saveConfig, setCliKnobOverride, _resetCliKnobsCache, type ServerConfig, type LLMConfig } from '@kinqs/brainrouter-core/dist/config/config.js';
import {
  listProviderNames, setProvider, removeProvider, setAgentModel, describeAgentModel, SUBAGENT_ROLES,
} from '@kinqs/brainrouter-core/dist/provider/agentModels.js';
import {
  readPreferences,
  writePreferences,
  resolveEffort,
  type Preferences,
  type EffortLevel,
  type ExecutionMode,
  type ReviewPolicy,
} from '@kinqs/brainrouter-core/dist/session/preferencesStore.js';
import { setSessionRuntime } from '@kinqs/brainrouter-core/dist/session/sessionRuntimeStore.js';
import { isKnownSegment, SEGMENT_NAMES } from '../statusline.js';
import { PROVIDER_CATALOG, maskApiKey, validateApiKey } from '@kinqs/brainrouter-core/dist/provider/catalog.js';
import { selectModel } from '../wizard/modelsApi.js';
// 0.3.7 — picker / prompt moved to Ink. The raw-stdout pickFromList /
// promptText primitives had compounding redraw bugs (frame creep on
// every keystroke, stacking on step transitions). Ink owns the render
// loop and diffs the cell grid, so all those issues are eliminated by
// design. The thin runPicker / runTextField wrappers mount + unmount
// a single Ink app per modal.
import { runPicker, runTextField, type PickerRow, type PickerResult, type TextFieldResult } from '../ink/runPicker.js';
const pickFromList = runPicker;
const promptText = runTextField;
import { buildTheme, type Theme } from '../theme.js';

/**
 * `/config` slash command — 0.3.7 redesign on the new atomic-frame picker
 * (`../wizard/picker.ts`).
 *
 * Persistence routes through `saveConfig` / `writePreferences` — never
 * touches JSON files directly so future schema changes stay centralized.
 */

// --- Public entrypoint -------------------------------------------------

export async function tryHandleConfigCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/config') return false;
  const parsed = parseConfigArgs(ctx.args);
  switch (parsed.mode) {
    case 'home':
      await runHomePanel(ctx);
      return true;
    case 'raw':
      printRawConfig(ctx);
      return true;
    case 'get':
      printKey(ctx, parsed.key);
      return true;
    case 'set':
      await setKey(ctx, parsed.key, parsed.value);
      return true;
  }
}

// --- Pure parser (exported for tests) ----------------------------------

export type ParsedConfigArgs =
  | { mode: 'home' }
  | { mode: 'raw' }
  | { mode: 'get'; key: string }
  | { mode: 'set'; key: string; value: string };

export function parseConfigArgs(args: string[]): ParsedConfigArgs {
  if (args.length === 0) return { mode: 'home' };
  const first = args[0].toLowerCase();
  if (first === 'raw' || first === '--raw' || first === 'json') return { mode: 'raw' };
  if (args.length === 1) return { mode: 'get', key: first };
  return { mode: 'set', key: first, value: args.slice(1).join(' ').trim() };
}

export function listKnownConfigKeys(): string[] {
  return Object.keys(KEY_HANDLERS);
}

export const WIRE_FORMAT_OPTIONS = ['default', 'chat-completions', 'responses', 'anthropic-messages', 'gemini-generate'] as const;
export type WireFormatOption = (typeof WIRE_FORMAT_OPTIONS)[number];
export type WireFormatOverride = Exclude<WireFormatOption, 'default'>;

export interface ProviderRequestFormatRow {
  id: string;
  label: string;
  description: string;
  savedNames: string[];
}

function normalizeWireProviderId(id: string | undefined): string {
  return (id ?? '').trim().toLowerCase();
}

export function listProviderRequestFormatRows(config: CommandContext['config']): ProviderRequestFormatRow[] {
  const savedByProvider = new Map<string, string[]>();
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const id = normalizeWireProviderId(provider.provider || name);
    if (!id) continue;
    const names = savedByProvider.get(id) ?? [];
    names.push(name);
    savedByProvider.set(id, names);
  }

  const catalogById = new Map(PROVIDER_CATALOG.map((p) => [normalizeWireProviderId(p.id), p] as const));
  const rows: ProviderRequestFormatRow[] = [];
  const seen = new Set<string>();
  const add = (rawId: string, fallbackLabel?: string): void => {
    const id = normalizeWireProviderId(rawId);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const catalog = catalogById.get(id);
    const savedNames = savedByProvider.get(id) ?? [];
    const label = catalog?.label ?? fallbackLabel ?? id;
    const bits = [`provider id: ${id}`];
    if (savedNames.length) bits.push(`saved as ${savedNames.join(', ')}`);
    rows.push({ id, label, savedNames, description: bits.join(' · ') });
  };

  for (const provider of PROVIDER_CATALOG) add(provider.id, provider.label);
  for (const id of savedByProvider.keys()) add(id);
  return rows;
}

export function applyProviderRequestFormat(config: CommandContext['config'], providerId: string, format: WireFormatOption): { ok: true } | { ok: false; error: string } {
  const id = normalizeWireProviderId(providerId);
  if (!id) return { ok: false, error: 'Provider id is required.' };
  if (!WIRE_FORMAT_OPTIONS.includes(format)) return { ok: false, error: `Unsupported wire format: ${format}` };

  const next: Record<string, WireFormatOverride> = { ...(config.cli?.providerRequestFormat ?? {}) };
  if (format === 'default') delete next[id];
  else next[id] = format;

  config.cli = { ...(config.cli ?? {}) };
  if (Object.keys(next).length === 0) delete config.cli.providerRequestFormat;
  else config.cli.providerRequestFormat = next;
  return { ok: true };
}

// --- Settings home panel -----------------------------------------------

async function runHomePanel(ctx: CommandContext): Promise<void> {
  const { agent } = ctx;
  let cursor = 0;
  while (true) {
    const theme = buildTheme(readPreferences(agent.workspaceRoot).theme === 'mono' ? 'mono' : readPreferences(agent.workspaceRoot).theme === 'light' ? 'light' : 'dark');
    const rows = buildPanelRows(ctx);
    const pickerRows: PickerRow[] = rows.map((r) => ({
      id: r.key,
      label: r.label,
      value: r.current(),
      disabled: r.key === '__separator__',
    }));
    const result = await pickFromList({
      theme,
      title: '⚙️  /config',
      subtitle: `Workspace: ${agent.workspaceRoot}.  Edit a row, or pick "View raw config" to dump the scrubbed JSON.`,
      rows: pickerRows,
      initialCursor: cursor,
      footer: '↑/↓ navigate  ·  ↵ edit row  ·  esc / q close',
    });
    if (result.kind !== 'pick') return;
    const picked = rows.find((r) => r.key === result.id);
    if (!picked) return;
    cursor = rows.indexOf(picked);
    if (picked.key === '__exit') return;
    if (picked.key === '__raw') {
      await showRawConfigPanel(ctx, theme);
      continue;
    }
    try {
      await picked.edit(ctx);
    } catch (err: any) {
      console.log(chalk.red(`\n  /config "${picked.label}" failed: ${err?.message ?? err}\n`));
    }
  }
}

interface PanelRow {
  key: string;
  label: string;
  current: () => string;
  edit: (ctx: CommandContext) => Promise<boolean>;
}

function buildPanelRows(ctx: CommandContext): PanelRow[] {
  const { agent, config } = ctx;
  const prefs = () => readPreferences(agent.workspaceRoot);
  return [
    {
      key: 'llm',
      label: 'Default provider',
      current: () => {
        const name = findDefaultProviderName(ctx);
        if (name) {
          const p = config.providers?.[name];
          return `${name} · ${p?.model ?? '(model unset)'}`;
        }
        const llm = config.llm;
        if (!llm) return '(not configured)';
        return `${llm.model} · not saved as a Provider`;
      },
      edit: editDefaultProvider,
    },
    {
      key: 'mcp',
      label: 'MCP servers',
      current: () => {
        const profiles = Object.keys(config.servers);
        if (profiles.length === 0) return '(none configured)';
        const active = config.activeServer && config.servers[config.activeServer] ? config.activeServer : profiles[0];
        const others = profiles.filter((p) => p !== active);
        const head = `★ ${active}`;
        if (others.length === 0) return head;
        const tail = others.length <= 2 ? others.join(', ') : `${others.slice(0, 2).join(', ')}, +${others.length - 2}`;
        return `${head} + ${tail}`;
      },
      edit: editMcp,
    },
    {
      key: 'providers',
      label: 'Providers',
      current: () => {
        const names = listProviderNames(config);
        return names.length === 0 ? '(none configured)' : names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')}, +${names.length - 3}`;
      },
      edit: editProviders,
    },
    {
      key: 'web-search',
      label: 'Web search',
      current: () => {
        const ws = config.cli?.webSearch ?? {};
        return `${ws.provider ?? getCliKnobs().webSearch.provider} · robots ${ws.crawler?.respectRobots === false ? 'off' : 'on'}`;
      },
      edit: editWebSearch,
    },
    {
      key: 'agent-models',
      label: 'Sub-agent models',
      current: () => {
        const roles = SUBAGENT_ROLES.filter((r) => config.agentModels?.[r]);
        if (roles.length === 0) return '(all inherit the main model)';
        return roles.map((r) => `${r}→${describeAgentModel(config, r)}`).slice(0, 2).join(' · ') + (roles.length > 2 ? ` +${roles.length - 2}` : '');
      },
      edit: editAgentModels,
    },
    { key: 'theme',         label: 'Theme',            current: () => prefs().theme,                 edit: editTheme },
    { key: 'statusline',    label: 'Statusline',       current: () => prefs().statusline,            edit: editStatusline },
    { key: 'effort',        label: 'Reasoning effort', current: () => `${resolveEffort(agent.workspaceRoot).effort} (${resolveEffort(agent.workspaceRoot).source})`, edit: editEffort },
    { key: 'mode',          label: 'Execution mode',   current: () => prefs().executionMode,         edit: editExecutionMode },
    { key: 'review-policy', label: 'Review policy',    current: () => prefs().reviewPolicy,          edit: editReviewPolicy },
    { key: 'quiet',         label: 'Quiet mode',       current: () => prefs().quiet ? 'on' : 'off',  edit: toggleQuiet },
    { key: 'personality',   label: 'Personality',      current: () => prefs().personality,           edit: editPersonality },
    { key: 'editor',        label: 'Editor mode',      current: () => prefs().editorMode,            edit: editEditorMode },
    {
      key: 'wire-format',
      label: 'Wire format (per provider)',
      current: () => {
        // Live-read so the row summary stays in sync after a sub-pick without
        // needing to re-enter the home panel.
        const overrides = getCliKnobs().providerRequestFormat ?? {};
        const entries = Object.entries(overrides);
        if (entries.length === 0) return '(all using built-in defaults)';
        const head = entries.slice(0, 3).map(([k, v]) => `${k} → ${v}`);
        return entries.length <= 3 ? head.join(' · ') : `${head.join(' · ')}, +${entries.length - 3}`;
      },
      edit: editWireFormat,
    },
    { key: '__raw',         label: 'View raw config',  current: () => 'JSON dump',                   edit: async () => false },
    { key: '__exit',        label: 'Quit (esc)',       current: () => '',                            edit: async () => false },
  ];
}

function shortenEndpoint(url?: string): string {
  if (!url) return 'default endpoint';
  return url.replace(/^https?:\/\//, '').replace(/\/v1.*$/, '').replace(/\/api\/v1.*$/, '');
}

function findDefaultProviderName(ctx: CommandContext): string | undefined {
  const llm = ctx.config.llm;
  if (!llm) return undefined;
  return Object.entries(ctx.config.providers ?? {}).find(([, p]) =>
    p.provider === llm.provider &&
    p.model === llm.model &&
    (p.endpoint ?? '') === (llm.endpoint ?? '') &&
    p.apiKey === llm.apiKey
  )?.[0];
}

function setDefaultProvider(ctx: CommandContext, name: string): boolean {
  const provider = ctx.config.providers?.[name];
  if (!provider) return false;
  ctx.config.llm = { ...provider };
  const fallback = ctx.config.agentModels?.default;
  const fallbackDuplicatesMain =
    !!fallback &&
    (
      (fallback.provider === name && (!fallback.model || fallback.model === provider.model)) ||
      (!fallback.provider && (!fallback.model || fallback.model === provider.model))
    );
  if (fallbackDuplicatesMain) ctx.config = setAgentModel(ctx.config, 'default', {});
  saveConfig(ctx.config);
  ctx.agent.setLLMConfig(provider);
  return true;
}

function subagentRoleLabel(role: string): string {
  return role === 'default' ? 'Fallback for sub-agents' : role;
}

function setAgentModelNormalized(ctx: CommandContext, role: string, provider: string | undefined, model: string): boolean {
  const defaultProvider = findDefaultProviderName(ctx);
  const providerCfg = provider ? ctx.config.providers?.[provider] : undefined;
  const duplicatesMain =
    (!provider && (!model || model === ctx.config.llm?.model)) ||
    (!!provider && provider === defaultProvider && (!model || model === providerCfg?.model));
  ctx.config = setAgentModel(ctx.config, role, duplicatesMain ? {} : { provider, model });
  saveConfig(ctx.config);
  return duplicatesMain;
}

function parseKeyValueLines(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\n|;/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function formatKeyValueLines(values?: Record<string, string>): string {
  return values ? Object.entries(values).map(([k, v]) => `${k}=${v}`).join('; ') : '';
}

// --- Per-row editors ---------------------------------------------------

function themeFor(ctx: CommandContext): Theme {
  const mode = readPreferences(ctx.agent.workspaceRoot).theme;
  return buildTheme(mode === 'mono' ? 'mono' : mode === 'light' ? 'light' : 'dark');
}

/**
 * Shared provider→key→endpoint→model gather flow. Used by the main LLM editor,
 * the named-provider editor, and the per-sub-agent-role model picker. `current`
 * pre-fills the key/endpoint/model. Returns the gathered LLMConfig (+ a label
 * and a model-source tail for the success line), or null if the user backed out.
 */
async function gatherLlmConfig(
  ctx: CommandContext,
  theme: Theme,
  current?: LLMConfig,
): Promise<{ llm: LLMConfig; label: string; sourceTail: string } | null> {
  const provResult = await pickFromList({
    theme,
    title: 'LLM provider',
    subtitle: 'Pick a provider. The next step gathers the API key.',
    rows: PROVIDER_CATALOG.map((p) => ({
      id: p.id,
      label: p.label,
      value: p.local ? 'local · key optional' : 'cloud · needs key',
      description: p.hint,
    })),
    initialCursor: 0,
  });
  if (provResult.kind !== 'pick') return null;
  const provider = PROVIDER_CATALOG.find((p) => p.id === provResult.id);
  if (!provider) return null;
  const envValue = process.env[provider.envKey] ?? current?.apiKey ?? '';
  const keyResult = await promptText({
    theme,
    title: 'API key',
    subtitle: envValue
      ? `${provider.envKey} or current key pre-filled — press ENTER to accept, type to override.`
      : provider.local ? `${provider.label} is local — blank key OK.` : `Paste your ${provider.label} key.`,
    badge: provider.label,
    prefilled: envValue,
    placeholder: provider.local ? '(blank OK)' : 'paste API key',
    validate: (raw) => {
      const v = validateApiKey(raw, provider);
      return v.kind === 'reject' ? v.reason : undefined;
    },
  });
  if (keyResult.kind !== 'accept') return null;

  // OpenAI doubles as the OpenAI-compatible custom-endpoint flow. Prompt
  // to confirm or replace the base URL; local providers keep their
  // fixed loopback endpoints.
  let endpoint = provider.endpoint;
  if (provider.id === 'openai') {
    const cur = current?.endpoint ?? provider.endpoint;
    const urlResult = await promptText({
      theme,
      title: 'API base URL',
      subtitle: 'Press ENTER for OpenAI direct, or paste any OpenAI-compatible /v1 base URL (DeepSeek, OpenRouter, Together, Groq, vLLM, …).',
      badge: 'OpenAI base URL',
      prefilled: cur,
      placeholder: provider.endpoint,
      validate: (raw) => {
        const v = raw.trim();
        if (!v) return 'base URL cannot be empty';
        try { new URL(v); } catch { return 'must be a valid URL'; }
        return undefined;
      },
    });
    if (urlResult.kind !== 'accept') return null;
    endpoint = urlResult.text.trim();
  }

  // Live /v1/models picker — same one the in-REPL /model command uses.
  const modelResult = await selectModel({
    theme,
    provider,
    apiKey: keyResult.text,
    endpointOverride: endpoint !== provider.endpoint ? endpoint : undefined,
    currentModel: current?.model,
    title: 'Model',
    badge: provider.label,
    eraseOnClose: true,
  });
  if (!modelResult) return null;
  const model = modelResult.model;
  const endpointTail = endpoint !== provider.endpoint ? ` · ${shortenEndpoint(endpoint)}` : '';
  const sourceTail = (modelResult.source === 'live'
    ? ` (from live /v1/models · ${modelResult.liveCount} returned)`
    : modelResult.source === 'fallback'
      ? ` (live list unavailable — picked from curated short-list)`
      : '') + endpointTail;
  return { llm: { provider: provider.id, apiKey: keyResult.text, model, endpoint }, label: provider.label, sourceTail };
}

async function editDefaultProvider(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const names = listProviderNames(ctx.config);
  if (names.length === 0) {
    console.log(chalk.yellow('\n  No Providers are configured yet. Open /config → Providers and add one first.\n'));
    return false;
  }
  const current = findDefaultProviderName(ctx);
  const picked = await pickFromList({
    theme,
    title: 'Default provider',
    subtitle: 'Pick from saved Providers. Endpoint and API key are managed in the Providers row.',
    rows: names.map((name) => {
      const p = ctx.config.providers![name];
      return {
        id: name,
        label: name,
        value: `${p.model} · ${shortenEndpoint(p.endpoint)}`,
        description: name === current ? 'current default' : undefined,
      };
    }),
    initialCursor: current ? Math.max(0, names.indexOf(current)) : 0,
  });
  if (picked.kind !== 'pick') return false;
  if (!setDefaultProvider(ctx, picked.id)) return false;
  console.log(chalk.green(`\n  ✓ Default provider → "${picked.id}" · ${ctx.config.llm?.model ?? ''}\n`));
  return true;
}

// Exported so `/login` can re-enter the LLM editor as a follow-on step
// after the MCP transport block. Same flow as the `/config` panel's
// Legacy first-run LLM flow; /config now defaults through saved Providers.
export async function editLlm(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const gathered = await gatherLlmConfig(ctx, theme, ctx.config.llm);
  if (!gathered) return false;
  ctx.config.llm = gathered.llm;
  saveConfig(ctx.config);
  // setLLMConfig (not just setModel) so the live agent picks up the new
  // apiKey + endpoint immediately.
  ctx.agent.setLLMConfig(ctx.config.llm);
  console.log(chalk.green(`\n  ✓ LLM saved: ${gathered.label} · ${gathered.llm.model} · ${maskApiKey(gathered.llm.apiKey)}${gathered.sourceTail}`));
  return true;
}

/**
 * `/config` → "LLM providers" row. Manage the NAMED OpenAI-compatible providers
 * (beyond the main `llm`) that sub-agents can be routed to. List → add / edit /
 * remove. Each is gathered with the same provider→key→endpoint→model flow.
 */
async function editProviders(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const names = listProviderNames(ctx.config);
  const rows = [
    ...names.map((n) => {
      const p = ctx.config.providers![n];
      return { id: n, label: n, value: `${p.model} · ${shortenEndpoint(p.endpoint)}`, description: 'Edit or remove' };
    }),
    { id: '__add', label: '+ Add a provider', value: '', description: 'A named OpenAI-compatible endpoint for the main agent or sub-agents' },
  ];
  const picked = await pickFromList({ theme, title: 'LLM providers', subtitle: 'Named OpenAI-compatible endpoints the main agent and sub-agents can use.', rows, initialCursor: 0 });
  if (picked.kind !== 'pick') return false;

  if (picked.id === '__add') {
    const nameResult = await promptText({ theme, title: 'Provider name', subtitle: 'A short id, e.g. "groq", "fast", "local".', badge: 'name', placeholder: 'groq',
      validate: (raw) => (/^[a-zA-Z0-9._-]+$/.test(raw.trim()) ? undefined : 'letters, digits, . _ - only') });
    if (nameResult.kind !== 'accept') return false;
    const name = nameResult.text.trim();
    const gathered = await gatherLlmConfig(ctx, theme);
    if (!gathered) return false;
    ctx.config = setProvider(ctx.config, name, gathered.llm);
    saveConfig(ctx.config);
    console.log(chalk.green(`\n  ✓ Provider "${name}" saved: ${gathered.label} · ${gathered.llm.model}${gathered.sourceTail}`));
    return true;
  }

  // Existing provider → edit or remove.
  const action = await pickFromList({ theme, title: `Provider "${picked.id}"`, subtitle: '', rows: [
    { id: 'default', label: 'Use as default', value: 'main model/provider', description: 'Copy this provider into config.llm without re-entering endpoint/key' },
    { id: 'edit', label: 'Edit', value: 're-enter key / endpoint / model', description: '' },
    { id: 'remove', label: 'Remove', value: 'also clears any sub-agent pointing at it', description: '' },
  ], initialCursor: 0 });
  if (action.kind !== 'pick') return false;
  if (action.id === 'default') {
    if (!setDefaultProvider(ctx, picked.id)) return false;
    console.log(chalk.green(`\n  ✓ Default provider → "${picked.id}" · ${ctx.config.llm?.model ?? ''}\n`));
    return true;
  }
  if (action.id === 'remove') {
    ctx.config = removeProvider(ctx.config, picked.id);
    saveConfig(ctx.config);
    console.log(chalk.green(`\n  ✓ Provider "${picked.id}" removed.`));
    return true;
  }
  const gathered = await gatherLlmConfig(ctx, theme, ctx.config.providers?.[picked.id]);
  if (!gathered) return false;
  ctx.config = setProvider(ctx.config, picked.id, gathered.llm);
  saveConfig(ctx.config);
  console.log(chalk.green(`\n  ✓ Provider "${picked.id}" updated: ${gathered.label} · ${gathered.llm.model}${gathered.sourceTail}`));
  return true;
}

function ensureWebSearchConfig(ctx: CommandContext): NonNullable<NonNullable<CommandContext['config']['cli']>['webSearch']> {
  ctx.config.cli = ctx.config.cli ?? {};
  ctx.config.cli.webSearch = ctx.config.cli.webSearch ?? {};
  return ctx.config.cli.webSearch;
}

async function editWebSearch(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const current = ctx.config.cli?.webSearch ?? {};
  const provider = current.provider ?? getCliKnobs().webSearch.provider;
  const picked = await pickFromList({
    theme,
    title: 'Web search',
    subtitle: 'Configure web_search provider keys and crawler behavior.',
    rows: [
      { id: 'provider', label: 'Provider', value: provider, description: 'duckduckgo, serper, google_pse, brave, searxng, custom_http' },
      { id: 'serper', label: 'Serper API key', value: current.serperApiKey ? maskApiKey(current.serperApiKey) : '(unset)', description: 'write-only key' },
      { id: 'google-key', label: 'Google PSE API key', value: current.google?.apiKey ? maskApiKey(current.google.apiKey) : '(unset)', description: 'write-only key' },
      { id: 'google-cx', label: 'Google PSE cx', value: current.google?.cx ? '(set)' : '(unset)', description: 'custom search engine id' },
      { id: 'brave', label: 'Brave API key', value: current.braveApiKey ? maskApiKey(current.braveApiKey) : '(unset)', description: 'write-only key' },
      { id: 'searxng', label: 'SearXNG URL', value: current.searxngBaseUrl ?? '(unset)', description: 'self-hosted base URL' },
      { id: 'robots', label: 'Respect robots.txt', value: current.crawler?.respectRobots === false ? 'off' : 'on', description: 'crawler policy' },
    ],
    initialCursor: 0,
  });
  if (picked.kind !== 'pick') return false;
  const ws = ensureWebSearchConfig(ctx);
  if (picked.id === 'provider') {
    const prov = await pickFromList({
      theme,
      title: 'Web search provider',
      subtitle: 'DuckDuckGo is keyless and keeps zero-config behavior.',
      rows: ['duckduckgo', 'serper', 'google_pse', 'brave', 'searxng', 'custom_http'].map((id) => ({ id, label: id, value: id === provider ? 'current' : '' })),
      initialCursor: 0,
    });
    if (prov.kind !== 'pick') return false;
    ws.provider = prov.id as NonNullable<typeof ws.provider>;
  } else if (picked.id === 'robots') {
    ws.crawler = { ...(ws.crawler ?? {}), respectRobots: ws.crawler?.respectRobots === false };
  } else {
    const labels: Record<string, string> = {
      serper: 'Serper API key',
      'google-key': 'Google PSE API key',
      'google-cx': 'Google PSE cx',
      brave: 'Brave API key',
      searxng: 'SearXNG base URL',
    };
    const result = await promptText({
      theme,
      title: labels[picked.id] ?? 'Web search value',
      subtitle: 'Stored in local config.json. Keys are masked in config output.',
      badge: 'web_search',
      placeholder: picked.id === 'searxng' ? 'https://search.example.com' : '',
      validate: (raw) => {
        const value = raw.trim();
        if (picked.id === 'searxng') {
          try { new URL(value); } catch { return 'must be a valid URL'; }
        }
        return undefined;
      },
    });
    if (result.kind !== 'accept') return false;
    const value = result.text.trim();
    if (picked.id === 'serper') ws.serperApiKey = value;
    if (picked.id === 'google-key') ws.google = { ...(ws.google ?? {}), apiKey: value };
    if (picked.id === 'google-cx') ws.google = { ...(ws.google ?? {}), cx: value };
    if (picked.id === 'brave') ws.braveApiKey = value;
    if (picked.id === 'searxng') ws.searxngBaseUrl = value;
  }
  saveConfig(ctx.config);
  _resetCliKnobsCache();
  console.log(chalk.green('\n  ✓ Web search settings saved.\n'));
  return true;
}

/**
 * `/config` → "Sub-agent models" row. Assign a provider/model to each sub-agent
 * role. The role named `default` is shown as "Fallback for sub-agents"; it is
 * not the main default provider. Pick a role → pick a provider (a named one,
 * the main LLM, or "inherit") → enter a model (blank = provider default).
 */
async function editAgentModels(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const roleRow = await pickFromList({
    theme,
    title: 'Sub-agent models',
    subtitle: 'Optional routing for spawned agents. Fallback applies only to roles without their own override.',
    rows: SUBAGENT_ROLES.map((r) => ({
      id: r,
      label: subagentRoleLabel(r),
      value: describeAgentModel(ctx.config, r),
      description: r === 'default' ? 'Optional fallback, not the main default provider' : '',
    })),
    initialCursor: 0,
  });
  if (roleRow.kind !== 'pick') return false;
  const role = roleRow.id;
  const roleLabel = subagentRoleLabel(role);

  const providerNames = listProviderNames(ctx.config);
  const provRow = await pickFromList({
    theme,
    title: `${roleLabel} → provider`,
    subtitle: role === 'default' ? 'Leave clear to let unconfigured sub-agents follow the main default provider.' : 'Where this role\'s model runs.',
    rows: [
      { id: '__inherit', label: role === 'default' ? 'Clear / follow Default provider' : 'Inherit (clear)', value: 'use the main default provider', description: 'Remove this override' },
      { id: '__main', label: 'Main provider', value: `${ctx.config.llm?.model ?? '—'} (config.llm)`, description: 'Same endpoint as the main agent, optionally a different model' },
      ...providerNames.map((n) => ({ id: n, label: n, value: `${ctx.config.providers![n].model}`, description: 'A named provider' })),
    ],
    initialCursor: 0,
  });
  if (provRow.kind !== 'pick') return false;

  if (provRow.id === '__inherit') {
    ctx.config = setAgentModel(ctx.config, role, {});
    saveConfig(ctx.config);
    console.log(chalk.green(`\n  ✓ ${roleLabel} now follows the main default provider.`));
    return true;
  }

  const providerId = provRow.id === '__main' ? undefined : provRow.id;
  const defaultModel = providerId ? ctx.config.providers?.[providerId]?.model : ctx.config.llm?.model;
  const modelResult = await promptText({
    theme,
    title: `${roleLabel} → model`,
    subtitle: `Model id for this role. Blank = ${providerId ? `the provider's default (${defaultModel ?? '?'})` : 'the main model'}.`,
    badge: providerId ?? 'main',
    prefilled: ctx.config.agentModels?.[role]?.model ?? '',
    placeholder: defaultModel ?? 'model id',
  });
  if (modelResult.kind !== 'accept') return false;
  const cleared = setAgentModelNormalized(ctx, role, providerId, modelResult.text.trim());
  console.log(chalk.green(`\n  ✓ ${roleLabel} → ${cleared ? 'follows the main default provider' : describeAgentModel(ctx.config, role)}`));
  return true;
}

/**
 * `/config` → MCP row. 0.3.7 multi-MCP redesign — now a profile
 * MANAGER instead of a single-transport picker.
 *
 * Top-level panel lists every entry in `config.servers` (third-party MCPs
 * connect concurrently; only one BrainRouter MCP is active at a time) plus
 * rows for adding a new profile, choosing which one is highlighted in the
 * banner, and exiting. Picking an existing profile opens a sub-panel
 * (edit URL/command, update API key, probe, remove). Adding a new
 * profile runs a 4-step flow (name → transport → fields → API key)
 * and auto-connects via the running pool when possible — no CLI
 * restart needed.
 *
 */
async function editMcp(ctx: CommandContext): Promise<boolean> {
  while (true) {
    const theme = themeFor(ctx);
    const profileIds = Object.keys(ctx.config.servers);
    const ROW_ADD = '__add__';
    const ROW_ACTIVE = '__active__';
    const ROW_DONE = '__done__';
    const rows: PickerRow[] = [
      ...profileIds.map((id) => {
        const s = ctx.config.servers[id];
        const isActive = id === ctx.config.activeServer;
        const transportLabel = s.type === 'http' ? `http · ${s.url ?? ''}` : `stdio · ${s.command ?? ''}`;
        const tags: string[] = [];
        if (s.identity === 'brainrouter') tags.push('brainrouter');
        if (s.apiKey) tags.push(`key ${maskApiKey(s.apiKey)}`);
        return {
          id,
          label: `${isActive ? '★ ' : '  '}${id}`,
          value: transportLabel + (tags.length ? `  ·  ${tags.join(' · ')}` : ''),
          description: isActive
            ? 'highlighted in banner; selects active BrainRouter when this profile is BrainRouter'
            : undefined,
        };
      }),
      { id: ROW_ADD,    label: '+ Add new MCP server', value: '', description: 'Register another MCP (third-party tool, additional brain instance, etc.)' },
      ...(profileIds.length > 0
        ? [{ id: ROW_ACTIVE, label: 'Set highlighted server', value: ctx.config.activeServer || '(none)', description: 'Banner highlight + single-server fallback for --profile' }]
        : []),
      { id: ROW_DONE,   label: 'Done',                 value: '', description: 'Close this panel' },
    ];
    const result = await pickFromList({
      theme,
      title: 'MCP servers',
      subtitle: `${profileIds.length} configured · third-party MCPs connect together; only one BrainRouter MCP is active. ★ = highlighted.`,
      rows,
    });
    if (result.kind !== 'pick' || result.id === ROW_DONE) return true;
    if (result.id === ROW_ADD) {
      const addedId = await addMcpProfile(ctx, theme);
      if (addedId) {
        // First-added profile auto-becomes the highlighted one if
        // nothing was selected before — avoids a confused banner.
        if (!ctx.config.activeServer || !ctx.config.servers[ctx.config.activeServer]) {
          ctx.config.activeServer = addedId;
        }
        saveConfig(ctx.config);
        await tryConnectInPool(ctx, addedId);
      }
      continue;
    }
    if (result.id === ROW_ACTIVE) {
      await setActiveProfile(ctx, theme, profileIds);
      continue;
    }
    // Picked an existing profile id.
    await editExistingMcpProfile(ctx, theme, result.id);
  }
}

/**
 * Walk a user through adding a new MCP profile:
 *   1. Name (validated unique, [a-z0-9_-])
 *   2. Identity hint (BrainRouter vs third-party — drives the
 *      BRAINROUTER_API_KEY env pre-fill on the key step)
 *   3. Transport (stdio / local-http / remote-http)
 *   4. Fields (command for stdio, URL for http)
 *   5. API key (env pre-fill for BrainRouter; blank OK for any
 *      unauthenticated transport)
 * Returns the new profile id on success, undefined on cancel.
 */
async function addMcpProfile(ctx: CommandContext, theme: Theme): Promise<string | undefined> {
  const nameRes = await promptText({
    theme,
    title: 'New MCP server — name',
    subtitle: 'Short identifier. Used in tool prefixes: mcp_<name>_<tool>.',
    badge: 'MCP',
    placeholder: 'github, filesystem, my-brain, …',
    validate: (raw) => {
      const v = raw.trim();
      if (!v) return 'name required';
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(v)) return 'use letters, digits, underscore, or dash (must start with letter or digit)';
      if (ctx.config.servers[v]) return `"${v}" already exists — edit it from the list instead`;
      return undefined;
    },
  });
  if (nameRes.kind !== 'accept') return undefined;
  const name = nameRes.text.trim();

  const identityRes = await pickFromList({
    theme,
    title: `Identity for "${name}"`,
    subtitle: 'Brainrouter MCPs get BRAINROUTER_API_KEY pre-fill on the key step. Third-party MCPs do not.',
    rows: [
      { id: 'third-party', label: 'Third-party MCP', value: 'default', description: 'GitHub, filesystem, browser tools, anything not BrainRouter' },
      { id: 'brainrouter', label: 'BrainRouter MCP', value: 'memory + skills', description: 'Another BrainRouter brain (multi-instance setup)' },
    ],
  });
  if (identityRes.kind !== 'pick') return undefined;
  const identity = identityRes.id as 'brainrouter' | 'third-party';

  const transportRes = await pickFromList({
    theme,
    title: 'Transport',
    subtitle: `How does the CLI reach "${name}"?`,
    rows: [
      { id: 'stdio',       label: 'Stdio',       value: 'spawn a child process', description: 'Run a local command; communicate over stdin/stdout' },
      { id: 'local-http',  label: 'Local HTTP',  value: 'localhost',             description: 'Connect to a server already running on localhost' },
      { id: 'remote-http', label: 'Remote HTTP', value: 'custom URL',            description: 'Connect to a hosted MCP server (URL + API key)' },
    ],
  });
  if (transportRes.kind !== 'pick') return undefined;

  let server: ServerConfig | undefined;
  if (transportRes.id === 'stdio') {
    const cmdRes = await promptText({
      theme,
      title: 'Command',
      subtitle: 'Executable + args (space-separated). Example: npx @modelcontextprotocol/server-filesystem /tmp',
      badge: 'MCP',
      prefilled: identity === 'brainrouter' ? 'brainrouter-mcp' : '',
      placeholder: 'command [args...]',
      validate: (raw) => raw.trim() ? undefined : 'command required',
    });
    if (cmdRes.kind !== 'accept') return undefined;
    const parts = cmdRes.text.trim().split(/\s+/);
    const envRes = await promptText({
      theme,
      title: 'Environment variables',
      subtitle: 'Optional. KEY=value pairs separated by semicolons; useful for connector tokens, project ids, or feature flags.',
      badge: 'MCP env',
      placeholder: 'GITHUB_TOKEN=...; PROJECT_ID=...',
    });
    if (envRes.kind !== 'accept') return undefined;
    server = { type: 'stdio', command: parts[0], args: parts.slice(1), identity, env: parseKeyValueLines(envRes.text) };
  } else {
    const isLocal = transportRes.id === 'local-http';
    const urlRes = await promptText({
      theme,
      title: 'URL',
      subtitle: isLocal ? 'Local MCP endpoint URL (e.g. http://localhost:3747/mcp).' : 'Full URL to the hosted MCP (https://…/mcp).',
      badge: 'MCP',
      prefilled: isLocal ? 'http://localhost:3747/mcp' : '',
      placeholder: 'https://...',
      validate: (raw) => {
        const v = raw.trim();
        if (!v) return 'URL required';
        try { new URL(v); } catch { return 'not a valid URL'; }
        return undefined;
      },
    });
    if (urlRes.kind !== 'accept') return undefined;
    // BrainRouter MCPs go through the shared `promptBrainrouterApiKey`
    // helper (BRAINROUTER_API_KEY env pre-fill + brainrouter-shaped
    // subtitle). Third-party MCPs get a generic "bearer token" prompt
    // so we don't suggest a wrong env var name.
    let apiKey: string | undefined;
    if (identity === 'brainrouter') {
      apiKey = await promptBrainrouterApiKey(theme, isLocal ? 'local' : 'remote', undefined);
      if (apiKey === undefined) return undefined;
    } else {
      const keyRes = await promptText({
        theme,
        title: 'API key / bearer token',
        subtitle: `Authorization header for "${name}". Leave blank if the server is unauthenticated.`,
        badge: 'MCP',
        prefilled: '',
        placeholder: '(blank OK)',
      });
      if (keyRes.kind !== 'accept') return undefined;
      apiKey = keyRes.text.trim();
    }
    const headersRes = await promptText({
      theme,
      title: 'HTTP headers',
      subtitle: 'Optional. Header-Name=value pairs separated by semicolons; Authorization is filled from the API key unless set here.',
      badge: 'MCP headers',
      placeholder: 'X-Workspace=...; X-Project=...',
    });
    if (headersRes.kind !== 'accept') return undefined;
    server = {
      type: 'http',
      url: urlRes.text.trim(),
      apiKey: apiKey || undefined,
      headers: parseKeyValueLines(headersRes.text),
      identity,
    };
  }
  ctx.config.servers[name] = server;
  console.log(chalk.green(`\n  ✓ "${name}" added.`));
  return name;
}

/**
 * Per-profile sub-panel: edit URL/command, update API key, probe,
 * remove. Re-enters on every action so the user can chain edits
 * before exiting back to the profile list.
 */
async function editExistingMcpProfile(ctx: CommandContext, theme: Theme, id: string): Promise<void> {
  while (true) {
    const server = ctx.config.servers[id];
    if (!server) return; // got removed mid-loop
    const summary = server.type === 'http'
      ? `http · ${server.url ?? ''}${server.apiKey ? ` · key ${maskApiKey(server.apiKey)}` : ''}${server.headers ? ` · ${Object.keys(server.headers).length} headers` : ''}`
      : `stdio · ${server.command ?? ''} ${(server.args ?? []).join(' ')}${server.env ? ` · ${Object.keys(server.env).length} env` : ''}`;
    const result = await pickFromList({
      theme,
      title: `MCP profile · ${id}`,
      subtitle: `${summary}  ·  identity: ${server.identity ?? 'unknown'}`,
      rows: [
        ...(server.type === 'http'
          ? [{ id: 'url',     label: 'Edit URL',     value: server.url ?? '',  description: 'Change the HTTP endpoint' } as PickerRow]
          : [{ id: 'command', label: 'Edit command', value: `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim(), description: 'Change the stdio command + args' } as PickerRow]),
        ...(server.type === 'http'
          ? [{ id: 'headers', label: 'Edit headers', value: server.headers ? `${Object.keys(server.headers).length} set` : '(none)', description: 'Custom HTTP headers / connector variables' } as PickerRow]
          : [{ id: 'env', label: 'Edit environment', value: server.env ? `${Object.keys(server.env).length} set` : '(none)', description: 'Environment variables for the stdio process' } as PickerRow]),
        { id: 'apikey',  label: 'Update API key', value: server.apiKey ? maskApiKey(server.apiKey) : '(none)', description: 'Bearer token / Authorization header' },
        { id: 'probe',   label: 'Probe connection', value: '', description: 'Test reachability (5s timeout)' },
        { id: 'remove',  label: 'Remove this profile', value: '', description: 'Drops it from config and disconnects from the pool' },
        { id: 'back',    label: 'Back', value: '', description: 'Return to the profile list' },
      ],
    });
    if (result.kind !== 'pick' || result.id === 'back') return;

    if (result.id === 'url') {
      const r = await promptText({
        theme, title: 'URL', badge: 'MCP', prefilled: server.url ?? '', placeholder: 'https://...',
        validate: (raw) => {
          if (!raw.trim()) return 'URL required';
          try { new URL(raw.trim()); } catch { return 'not a valid URL'; }
          return undefined;
        },
      });
      if (r.kind === 'accept') {
        ctx.config.servers[id] = { ...server, type: 'http', url: r.text.trim() };
        saveConfig(ctx.config);
        // Reconnect the pool so the new URL takes effect immediately.
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ URL updated → ${r.text.trim()}\n`));
      }
      continue;
    }
    if (result.id === 'command') {
      const r = await promptText({
        theme, title: 'Command + args', badge: 'MCP',
        prefilled: `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim(),
        placeholder: 'command [args...]',
        validate: (raw) => raw.trim() ? undefined : 'command required',
      });
      if (r.kind === 'accept') {
        const parts = r.text.trim().split(/\s+/);
        ctx.config.servers[id] = { ...server, type: 'stdio', command: parts[0], args: parts.slice(1) };
        saveConfig(ctx.config);
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ Command updated.\n`));
      }
      continue;
    }
    if (result.id === 'headers' && server.type === 'http') {
      const r = await promptText({
        theme, title: 'HTTP headers', badge: 'MCP headers',
        prefilled: formatKeyValueLines(server.headers),
        placeholder: 'X-Workspace=...; X-Project=...',
        subtitle: 'Optional. Header-Name=value pairs separated by semicolons. Blank clears custom headers.',
      });
      if (r.kind === 'accept') {
        const headers = parseKeyValueLines(r.text);
        ctx.config.servers[id] = { ...server, headers };
        saveConfig(ctx.config);
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ Headers updated.\n`));
      }
      continue;
    }
    if (result.id === 'env' && server.type === 'stdio') {
      const r = await promptText({
        theme, title: 'Environment variables', badge: 'MCP env',
        prefilled: formatKeyValueLines(server.env),
        placeholder: 'GITHUB_TOKEN=...; PROJECT_ID=...',
        subtitle: 'Optional. KEY=value pairs separated by semicolons. Blank clears custom environment variables.',
      });
      if (r.kind === 'accept') {
        const env = parseKeyValueLines(r.text);
        ctx.config.servers[id] = { ...server, env };
        saveConfig(ctx.config);
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ Environment updated.\n`));
      }
      continue;
    }
    if (result.id === 'apikey') {
      let apiKey: string | undefined;
      if (server.identity === 'brainrouter') {
        const isLocal = server.type === 'http' && (server.url ?? '').includes('localhost');
        apiKey = await promptBrainrouterApiKey(theme, isLocal ? 'local' : 'remote', server.apiKey);
        if (apiKey === undefined) continue;
      } else {
        const r = await promptText({
          theme, title: 'API key', badge: 'MCP',
          prefilled: server.apiKey ?? '',
          placeholder: '(blank OK)',
          subtitle: `Bearer token for "${id}". Leave blank if the server doesn't require auth.`,
        });
        if (r.kind !== 'accept') continue;
        apiKey = r.text.trim();
      }
      ctx.config.servers[id] = { ...server, apiKey: apiKey || undefined };
      saveConfig(ctx.config);
      await tryReconnectInPool(ctx, id);
      console.log(chalk.green(`  ✓ API key updated.\n`));
      continue;
    }
    if (result.id === 'probe') {
      console.log(chalk.gray(`  Probing "${id}"…`));
      try {
        await (ctx.mcpClient as any).reconnectOne?.(id);
        const status = (ctx.mcpClient as any).getStatus?.(id);
        if (status?.status === 'connected') {
          console.log(chalk.green(`  ✓ "${id}" reachable (${status.toolCount ?? 0} tools).\n`));
        } else {
          console.log(chalk.red(`  ✗ "${id}" failed — ${status?.error ?? 'unknown'}\n`));
        }
      } catch (err: any) {
        console.log(chalk.red(`  ✗ probe failed: ${err?.message ?? err}\n`));
      }
      continue;
    }
    if (result.id === 'remove') {
      const confirm = await pickFromList({
        theme,
        title: `Remove "${id}"?`,
        subtitle: 'This deletes the profile from config.json and disconnects it from the pool.',
        rows: [
          { id: 'cancel', label: 'Cancel', value: 'default', description: 'Keep the profile' },
          { id: 'remove', label: 'Remove', value: '', description: 'Delete + disconnect' },
        ],
      });
      if (confirm.kind === 'pick' && confirm.id === 'remove') {
        try { await (ctx.mcpClient as any).disconnectOne?.(id); } catch { /* idempotent */ }
        delete ctx.config.servers[id];
        if (ctx.config.activeServer === id) {
          // Pick the next surviving profile as the new highlight, or
          // clear it if none remain.
          const remaining = Object.keys(ctx.config.servers);
          ctx.config.activeServer = remaining[0] ?? '';
        }
        saveConfig(ctx.config);
        console.log(chalk.yellow(`  ✓ Removed "${id}".\n`));
        return;
      }
      continue;
    }
  }
}

/**
 * Highlighted-server picker. The "active" profile is now just a
 * banner-highlight and the fallback for `--profile`; all configured
 * servers connect on boot regardless.
 */
async function setActiveProfile(ctx: CommandContext, theme: Theme, profileIds: string[]): Promise<void> {
  if (profileIds.length === 0) {
    console.log(chalk.yellow('\n  No profiles to choose from. Add one first.\n'));
    return;
  }
  const result = await pickFromList({
    theme,
    title: 'Highlighted MCP server',
    subtitle: 'Shows in the banner and is the default when --profile is omitted in non-interactive runs.',
    rows: profileIds.map((id) => {
      const s = ctx.config.servers[id];
      const transport = s.type === 'http' ? `http · ${s.url ?? ''}` : `stdio · ${s.command ?? ''}`;
      return {
        id,
        label: id,
        value: transport,
        description: id === ctx.config.activeServer ? '(current)' : undefined,
      };
    }),
    initialCursor: Math.max(0, profileIds.indexOf(ctx.config.activeServer)),
  });
  if (result.kind !== 'pick') return;
  ctx.config.activeServer = result.id;
  saveConfig(ctx.config);
  console.log(chalk.green(`\n  ✓ Highlighted server → ${result.id}\n`));
}

/**
 * Best-effort live update: try to bring the new profile online in
 * the running pool without restart. The Pool's API surface lets us
 * call connectOne directly. Falls through silently if the runtime
 * `mcpClient` isn't actually a Pool (probe sites, etc.).
 */
async function tryConnectInPool(ctx: CommandContext, id: string): Promise<void> {
  const pool: any = ctx.mcpClient;
  if (typeof pool?.connectOne !== 'function') return;
  const cfg = ctx.config.servers[id];
  if (!cfg) return;
  try {
    await pool.connectOne(id, cfg, ctx.config.llm, 5_000);
    const status = pool.getStatus?.(id);
    if (status?.status === 'connected') {
      console.log(chalk.gray(`    → connected (${status.toolCount ?? 0} tools)`));
    } else if (status?.status === 'failed') {
      console.log(chalk.yellow(`    → saved but offline (${status.error ?? 'unknown'}). Try /mcp reconnect ${id} once the server is up.`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`    → connect attempt failed: ${err?.message ?? err}`));
  }
}

async function tryReconnectInPool(ctx: CommandContext, id: string): Promise<void> {
  const pool: any = ctx.mcpClient;
  if (typeof pool?.reconnectOne !== 'function') return;
  try {
    await pool.reconnectOne(id);
  } catch { /* user can /mcp reconnect manually */ }
}

/**
 * Shared prompt for the BrainRouter MCP HTTP API key (the
 * `BRAINROUTER_API_KEY` bearer token). Pre-fills from the env var if
 * set, then from the previously-saved key, then blank. Returns:
 *   - the trimmed key string (possibly empty when user chose "no key")
 *   - undefined when the user pressed Esc
 *
 * Exported so `/login` and any future MCP-setup surfaces share one
 * prompt copy — same subtitle text, same env-var pre-fill, same
 * "blank OK" semantics.
 */
export async function promptBrainrouterApiKey(
  theme: Theme,
  kind: 'local' | 'remote',
  existing?: string,
): Promise<string | undefined> {
  const envValue = process.env.BRAINROUTER_API_KEY ?? '';
  const prefilled = envValue || existing || '';
  const subtitle = envValue
    ? 'BRAINROUTER_API_KEY is set — press ENTER to accept, type to override, or blank for an unauthenticated server.'
    : kind === 'local'
      ? 'Optional — leave blank if your local brainrouter-mcp HTTP server runs without auth. Required when BRAINROUTER_API_KEY is set on the server side.'
      : 'Optional — leave blank if the hosted MCP doesn\'t require auth. Use the key issued by the BrainRouter dashboard (Users → Profile).';
  const result = await promptText({
    theme,
    title: 'BrainRouter API key',
    subtitle,
    badge: 'MCP',
    prefilled,
    placeholder: '(blank OK)',
  });
  if (result.kind !== 'accept') return undefined;
  return result.text.trim();
}


/**
 * `/config` → "Wire format (per provider)" row. Lets the user override
 * `cli.providerRequestFormat[providerId]` for every built-in catalog id and
 * the underlying provider id of each saved provider. The key intentionally
 * matches `llm.provider`, not the saved provider's friendly name.
 *
 * Each pick:
 *   1. Provider id — builtin or configured custom provider (deduped).
 *   2. Wire format — `(default)` | `chat-completions` | `responses` |
 *      `anthropic-messages` | `gemini-generate` (the last two are native,
 *      non-OpenAI-compatible, for the Anthropic/Gemini providers).
 * Picking `(default)` removes the provider's key from the map; the others
 * set it. Persists through `saveConfig` so CLI and Desktop share the same
 * `cli.providerRequestFormat` map.
 */
async function editWireFormat(ctx: CommandContext): Promise<boolean> {
  while (true) {
    const theme = themeFor(ctx);
    const rows = listProviderRequestFormatRows(ctx.config);
    if (rows.length === 0) {
      console.log(chalk.yellow('\n  No providers to configure. Add one under "Providers" first.\n'));
      return false;
    }
    const overrides = getCliKnobs().providerRequestFormat ?? {};
    const pickerRows: PickerRow[] = rows.map((row) => {
      const cur = overrides[row.id];
      return {
        id: row.id,
        label: row.label,
        value: cur ?? 'default',
        description: cur ? `${row.description} · override: ${cur}` : `${row.description} · default`,
      };
    });
    const picked = await pickFromList({
      theme,
      title: 'Wire format',
      subtitle: 'Override the OpenAI wire format per provider (`/v1/responses` vs `/v1/chat/completions`). Leave as "default" to use BrainRouter\'s built-in routing for that provider.',
      rows: pickerRows,
      initialCursor: 0,
      footer: '↑/↓ pick provider  ·  ↵ change format  ·  esc back',
    });
    if (picked.kind !== 'pick') return true;

    const cur = overrides[picked.id];
    const cursor = Math.max(0, WIRE_FORMAT_OPTIONS.indexOf((cur as WireFormatOption | undefined) ?? 'default'));
    const formatRow = await pickFromList({
      theme,
      title: `Wire format → ${picked.id}`,
      subtitle: 'Built-in routing uses Responses where the provider declares it (canonical OpenAI today). "chat-completions" forces /v1/chat/completions; "responses" forces /v1/responses; the native formats speak Anthropic/Gemini directly (non-OpenAI-compatible) — use only for those providers with a real key.',
      rows: [
        { id: 'default',         label: '(default)',         value: 'built-in routing',     description: 'Remove the override for this provider' },
        { id: 'chat-completions', label: 'chat-completions',  value: '/v1/chat/completions', description: 'Always POST chat/completions' },
        { id: 'responses',       label: 'responses',          value: '/v1/responses',        description: 'Always POST responses (assumes your gateway supports it)' },
        { id: 'anthropic-messages', label: 'anthropic-messages', value: '/v1/messages',       description: 'Native Anthropic Messages API (Anthropic provider only)' },
        { id: 'gemini-generate',  label: 'gemini-generate',   value: ':generateContent',     description: 'Native Gemini generateContent API (Gemini provider only)' },
      ],
      initialCursor: cursor,
    });
    if (formatRow.kind !== 'pick') continue;

    const applied = applyProviderRequestFormat(ctx.config, picked.id, formatRow.id as WireFormatOption);
    if (!applied.ok) {
      console.log(chalk.red(`\n  ${applied.error}\n`));
      continue;
    }
    saveConfig(ctx.config);
    _resetCliKnobsCache();
    const after = formatRow.id === 'default' ? 'default' : formatRow.id;
    console.log(chalk.green(`\n  ✓ ${picked.id} → ${after}\n`));
  }
}

async function editTheme(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const result = await pickFromList({
    theme,
    title: 'Theme',
    subtitle: 'Pick a color palette.',
    rows: [
      { id: 'dark',  label: 'Dark',  description: 'saturated accents on black' },
      { id: 'light', label: 'Light', description: 'darker accents for white terminals' },
      { id: 'mono',  label: 'Mono',  description: 'no color' },
      { id: 'auto',  label: 'Auto',  description: 'falls back to dark for now' },
    ],
  });
  if (result.kind !== 'pick') return false;
  writePreferences(ctx.agent.workspaceRoot, { theme: result.id as Preferences['theme'] });
  console.log(chalk.green(`\n  ✓ Theme → ${result.id}\n`));
  return true;
}

async function editStatusline(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const current = readPreferences(ctx.agent.workspaceRoot).statusline;
  const result = await promptText({
    theme,
    title: 'Statusline segments',
    subtitle: `Comma-separated subset of: ${SEGMENT_NAMES.join(', ')}`,
    prefilled: current,
    placeholder: 'mode,branch,workflow,goal',
    validate: (raw) => {
      const segments = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = segments.filter((s) => !isKnownSegment(s));
      if (unknown.length > 0) return `unknown segment(s): ${unknown.join(', ')}`;
      return undefined;
    },
  });
  if (result.kind !== 'accept') return false;
  const segments = result.text.split(',').map((s) => s.trim()).filter(Boolean);
  writePreferences(ctx.agent.workspaceRoot, { statusline: segments.join(',') });
  ctx.repl.refreshPromptForMode();
  console.log(chalk.green(`\n  ✓ Statusline → ${segments.join(',')}\n`));
  return true;
}

async function editEffort(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const result = await pickFromList({
    theme,
    title: 'Reasoning effort',
    subtitle: 'How hard should the model think? Orthogonal to /mode.',
    rows: [
      { id: 'low',    label: 'Low',    description: 'terse, one-paragraph answers' },
      { id: 'medium', label: 'Medium', value: 'default', description: 'no overlay, no provider reasoning slot' },
      { id: 'high',   label: 'High',   description: 'step-by-step audit before each tool call' },
    ],
  });
  if (result.kind !== 'pick') return false;
  writePreferences(ctx.agent.workspaceRoot, { effort: result.id as EffortLevel });
  ctx.agent.refreshSystemPrompt();
  console.log(chalk.green(`\n  ✓ Effort → ${result.id}\n`));
  return true;
}

async function editExecutionMode(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const result = await pickFromList({
    theme,
    title: 'Execution mode',
    rows: [
      { id: 'planning', label: 'Planning', value: 'default', description: 'every run_command y/N' },
      { id: 'fast',     label: 'Fast',     description: 'safe commands auto-run; dangerous still prompt' },
    ],
  });
  if (result.kind !== 'pick') return false;
  writePreferences(ctx.agent.workspaceRoot, { executionMode: result.id as ExecutionMode });
  console.log(chalk.green(`\n  ✓ Execution mode → ${result.id}\n`));
  return true;
}

async function editReviewPolicy(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const result = await pickFromList({
    theme,
    title: 'Review policy',
    rows: [
      { id: 'request', label: 'Request', value: 'default', description: 'prompt for /approve at multi-file gates' },
      { id: 'proceed', label: 'Proceed', description: 'apply plan and report after' },
    ],
  });
  if (result.kind !== 'pick') return false;
  writePreferences(ctx.agent.workspaceRoot, { reviewPolicy: result.id as ReviewPolicy });
  console.log(chalk.green(`\n  ✓ Review policy → ${result.id}\n`));
  return true;
}

async function editPersonality(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const result = await pickFromList({
    theme,
    title: 'Personality',
    subtitle: 'Communication style for agent responses.',
    rows: [
      { id: 'concise',         label: 'Concise',         description: 'short responses' },
      { id: 'standard',        label: 'Standard',        value: 'default' },
      { id: 'detailed',        label: 'Detailed',        description: 'verbose explanations' },
      { id: 'pair-programmer', label: 'Pair programmer', description: 'think-out-loud' },
    ],
  });
  if (result.kind !== 'pick') return false;
  writePreferences(ctx.agent.workspaceRoot, { personality: result.id as Preferences['personality'] });
  ctx.agent.refreshSystemPrompt();
  console.log(chalk.green(`\n  ✓ Personality → ${result.id}\n`));
  return true;
}

async function editEditorMode(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const result = await pickFromList({
    theme,
    title: 'Editor mode',
    rows: [
      { id: 'emacs', label: 'Emacs', value: 'default', description: 'standard readline keybindings' },
      { id: 'vi',    label: 'Vi',    description: 'vi keybindings (terminal-dependent)' },
    ],
  });
  if (result.kind !== 'pick') return false;
  writePreferences(ctx.agent.workspaceRoot, { editorMode: result.id as Preferences['editorMode'] });
  console.log(chalk.green(`\n  ✓ Editor mode → ${result.id}. Restart the CLI to apply.\n`));
  return true;
}

async function toggleQuiet(ctx: CommandContext): Promise<boolean> {
  const current = readPreferences(ctx.agent.workspaceRoot).quiet;
  const next = !current;
  writePreferences(ctx.agent.workspaceRoot, { quiet: next });
  setCliKnobOverride({ quiet: next });
  console.log(chalk.green(`\n  ✓ Quiet mode → ${next ? 'on' : 'off'}\n`));
  return true;
}

// --- get / set entrypoints ---------------------------------------------

async function showRawConfigPanel(ctx: CommandContext, theme: Theme): Promise<void> {
  const lines = buildRawConfigLines(ctx);
  await pickFromList({
    theme,
    title: '⚙️  Raw config',
    subtitle: `Scrubbed JSON from ${getConfigPath()}`,
    rows: [
      { id: 'back', label: 'Back to /config', description: 'Return to the settings panel' },
    ],
    footer: '↵ back  ·  esc / q back',
    onCursorChange: () => lines,
  });
}

function printRawConfig(ctx: CommandContext): void {
  console.log(chalk.bold('\n⚙️  Active Configuration:'));
  console.log(`  File Path: ${chalk.blue(getConfigPath())}\n`);
  console.log(chalk.gray(buildScrubbedConfigJson(ctx.config)));
  console.log();
}

export function buildScrubbedConfigJson(config: CommandContext['config']): string {
  const scrubbed = JSON.parse(JSON.stringify(config));
  scrubSecrets(scrubbed);
  return JSON.stringify(scrubbed, null, 2);
}

function buildRawConfigLines(ctx: CommandContext): string[] {
  return buildScrubbedConfigJson(ctx.config).split('\n');
}

function scrubSecrets(scrubbed: any): void {
  if (scrubbed.llm?.apiKey) scrubbed.llm.apiKey = maskApiKey(scrubbed.llm.apiKey);
  if (scrubbed.cli?.webSearch) {
    if (scrubbed.cli.webSearch.serperApiKey) scrubbed.cli.webSearch.serperApiKey = maskApiKey(scrubbed.cli.webSearch.serperApiKey);
    if (scrubbed.cli.webSearch.braveApiKey) scrubbed.cli.webSearch.braveApiKey = maskApiKey(scrubbed.cli.webSearch.braveApiKey);
    if (scrubbed.cli.webSearch.google?.apiKey) scrubbed.cli.webSearch.google.apiKey = maskApiKey(scrubbed.cli.webSearch.google.apiKey);
  }
  // Named provider keys (multi-provider routing) — these were NOT masked before,
  // so `/config show` leaked every saved provider's api key.
  for (const p of Object.values(scrubbed.providers ?? {})) {
    const prov = p as any;
    if (prov?.apiKey) prov.apiKey = maskApiKey(prov.apiKey);
  }
  for (const s of Object.values(scrubbed.servers ?? {})) {
    const srv = s as any;
    if (srv.apiKey) srv.apiKey = maskApiKey(srv.apiKey);
    if (srv.env?.BRAINROUTER_API_KEY) srv.env.BRAINROUTER_API_KEY = maskApiKey(srv.env.BRAINROUTER_API_KEY);
    // Custom auth headers on an MCP server profile (Authorization / x-api-key / …).
    if (srv.headers && typeof srv.headers === 'object') {
      for (const k of Object.keys(srv.headers)) {
        if (/authorization|api[-_]?key|token|secret|cookie/i.test(k) && typeof srv.headers[k] === 'string') {
          srv.headers[k] = maskApiKey(srv.headers[k]);
        }
      }
    }
  }
}

type SetResult = { ok: true; message: string } | { ok: false; reason: string };

interface ConfigKeyHandler {
  get: (ctx: CommandContext) => string;
  set?: (ctx: CommandContext, value: string) => SetResult | Promise<SetResult>;
}

// --- Workflow automation (cli.automation.*) ----------------------------
// The turn-end Requirement→Plan→Track→Sprint pipeline. All default OFF; these
// helpers are the first-class toggle surface (vs hand-editing config.json).
// Kept PURE (config-in, config-mutated) so they unit-test without a CommandContext.

type AutomationCfg = NonNullable<NonNullable<CommandContext['config']['cli']>['automation']>;

function automationBlock(cfg: CommandContext['config']): AutomationCfg {
  cfg.cli = cfg.cli ?? {};
  cfg.cli.automation = cfg.cli.automation ?? {};
  return cfg.cli.automation as AutomationCfg;
}

const TRUE_WORDS = ['on', 'true', '1', 'yes'];
const FALSE_WORDS = ['off', 'false', '0', 'no'];

/** Read the current state of an automation key as a display string. */
export function readAutomationKnob(cfg: CommandContext['config'], key: string): string {
  const a = cfg.cli?.automation ?? {};
  const tier = (stage?: { enabled?: boolean; autopilot?: boolean }): string =>
    !stage?.enabled ? 'off' : stage.autopilot ? 'autopilot' : 'propose';
  switch (key) {
    case 'automation': return a.enabled ? 'on' : 'off';
    case 'automation.requirements': return tier(a.requirements);
    case 'automation.sync': return a.sync?.enabled ? 'on' : 'off';
    case 'automation.sprints': return tier(a.sprints);
    default: return '(unknown)';
  }
}

/**
 * Apply an automation key=value to `cfg` (mutating cli.automation.*). Tiered
 * stages accept off | propose (alias on) | autopilot; boolean stages on|off.
 * Returns ok + a human message, or a reason on rejection. Pure — the caller
 * persists via saveConfig and refreshes the knob cache.
 */
export function applyAutomationKnob(
  cfg: CommandContext['config'],
  key: string,
  value: string,
): { ok: true; message: string } | { ok: false; reason: string } {
  const v = value.toLowerCase().trim();
  const a = automationBlock(cfg);
  const isTrue = TRUE_WORDS.includes(v);
  const isFalse = FALSE_WORDS.includes(v);
  switch (key) {
    case 'automation': {
      if (!isTrue && !isFalse) return { ok: false, reason: `automation must be on|off (got "${value}")` };
      a.enabled = isTrue;
      return { ok: true, message: isTrue
        ? 'automation → on (master switch; enable individual stages too)'
        : 'automation → off (master switch — nothing fires)' };
    }
    case 'automation.requirements': {
      if (isFalse) { a.requirements = { ...a.requirements, enabled: false }; return { ok: true, message: 'automation.requirements → off' }; }
      if (isTrue || v === 'propose') { a.requirements = { ...a.requirements, enabled: true, autopilot: false }; return { ok: true, message: 'automation.requirements → propose (draft + one-click promote)' }; }
      if (v === 'autopilot') { a.requirements = { ...a.requirements, enabled: true, autopilot: true }; return { ok: true, message: 'automation.requirements → autopilot (auto-create ready, cascade runs)' }; }
      return { ok: false, reason: `automation.requirements must be off|propose|autopilot (got "${value}")` };
    }
    case 'automation.sync': {
      if (!isTrue && !isFalse) return { ok: false, reason: `automation.sync must be on|off (got "${value}")` };
      a.sync = { ...a.sync, enabled: isTrue };
      return { ok: true, message: `automation.sync → ${isTrue ? 'on' : 'off'} (plan→Track items + code links)` };
    }
    case 'automation.sprints': {
      if (isFalse) { a.sprints = { ...a.sprints, enabled: false }; return { ok: true, message: 'automation.sprints → off' }; }
      if (isTrue || v === 'propose') { a.sprints = { ...a.sprints, enabled: true, autopilot: false }; return { ok: true, message: 'automation.sprints → propose (suggest only, no mutation)' }; }
      if (v === 'autopilot') { a.sprints = { ...a.sprints, enabled: true, autopilot: true }; return { ok: true, message: 'automation.sprints → autopilot (create/assign/complete; never auto-starts)' }; }
      return { ok: false, reason: `automation.sprints must be off|propose|autopilot (got "${value}")` };
    }
    default: return { ok: false, reason: `unknown automation key "${key}"` };
  }
}

function automationHandler(key: string): ConfigKeyHandler {
  return {
    get: (ctx) => readAutomationKnob(ctx.config, key),
    set: (ctx, value) => {
      const result = applyAutomationKnob(ctx.config, key, value);
      if (!result.ok) return result;
      saveConfig(ctx.config);
      _resetCliKnobsCache(); // pick up the change live (next getCliKnobs reloads)
      return result;
    },
  };
}

function webSearchHandler(path: 'provider' | 'serperApiKey' | 'googleApiKey' | 'googleCx' | 'braveApiKey' | 'searxngBaseUrl' | 'respectRobots'): ConfigKeyHandler {
  return {
    get: (ctx) => {
      const ws = ctx.config.cli?.webSearch ?? {};
      switch (path) {
        case 'provider': return ws.provider ?? getCliKnobs().webSearch.provider;
        case 'serperApiKey': return ws.serperApiKey ? maskApiKey(ws.serperApiKey) : '(unset)';
        case 'googleApiKey': return ws.google?.apiKey ? maskApiKey(ws.google.apiKey) : '(unset)';
        case 'googleCx': return ws.google?.cx ? '(set)' : '(unset)';
        case 'braveApiKey': return ws.braveApiKey ? maskApiKey(ws.braveApiKey) : '(unset)';
        case 'searxngBaseUrl': return ws.searxngBaseUrl ?? '(unset)';
        case 'respectRobots': return ws.crawler?.respectRobots === false ? 'off' : 'on';
      }
    },
    set: (ctx, value) => {
      const ws = ensureWebSearchConfig(ctx);
      const v = value.trim();
      if (path === 'provider') {
        if (!['duckduckgo', 'serper', 'google_pse', 'brave', 'searxng', 'custom_http'].includes(v)) {
          return { ok: false, reason: `web-search.provider must be duckduckgo|serper|google_pse|brave|searxng|custom_http (got "${value}")` };
        }
        ws.provider = v as NonNullable<typeof ws.provider>;
      } else if (path === 'serperApiKey') ws.serperApiKey = v;
      else if (path === 'googleApiKey') ws.google = { ...(ws.google ?? {}), apiKey: v };
      else if (path === 'googleCx') ws.google = { ...(ws.google ?? {}), cx: v };
      else if (path === 'braveApiKey') ws.braveApiKey = v;
      else if (path === 'searxngBaseUrl') {
        try { new URL(v); } catch { return { ok: false, reason: 'web-search.searxng-url must be a valid URL' }; }
        ws.searxngBaseUrl = v;
      } else {
        const on = TRUE_WORDS.includes(v.toLowerCase());
        const off = FALSE_WORDS.includes(v.toLowerCase());
        if (!on && !off) return { ok: false, reason: `web-search.respect-robots must be on|off (got "${value}")` };
        ws.crawler = { ...(ws.crawler ?? {}), respectRobots: on };
      }
      saveConfig(ctx.config);
      _resetCliKnobsCache();
      return { ok: true, message: `web-search.${path} saved` };
    },
  };
}

function computerUseHandler(path: 'enabled' | 'mode'): ConfigKeyHandler {
  return {
    get: (ctx) => {
      const c = ctx.config.cli?.computerUse ?? {};
      return path === 'enabled' ? (c.enabled ? 'on' : 'off') : (c.mode ?? getCliKnobs().computerUse.mode);
    },
    set: (ctx, value) => {
      ctx.config.cli = ctx.config.cli ?? {};
      ctx.config.cli.computerUse = ctx.config.cli.computerUse ?? {};
      if (path === 'enabled') {
        const v = value.toLowerCase().trim();
        const on = TRUE_WORDS.includes(v);
        const off = FALSE_WORDS.includes(v);
        if (!on && !off) return { ok: false, reason: `computer-use.enabled must be on|off (got "${value}")` };
        ctx.config.cli.computerUse.enabled = on;
      } else {
        const v = value.trim();
        if (!v) return { ok: false, reason: 'computer-use.mode cannot be empty' };
        ctx.config.cli.computerUse.mode = v;
      }
      saveConfig(ctx.config);
      _resetCliKnobsCache();
      return { ok: true, message: `computer-use.${path} saved` };
    },
  };
}

const KEY_HANDLERS: Record<string, ConfigKeyHandler> = {
  theme: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).theme,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['auto', 'light', 'dark', 'mono'].includes(v)) {
        return { ok: false, reason: `theme must be auto|light|dark|mono (got "${value}")` };
      }
      writePreferences(ctx.agent.workspaceRoot, { theme: v as Preferences['theme'] });
      return { ok: true, message: `theme → ${v}` };
    },
  },
  statusline: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).statusline,
    set: (ctx, value) => {
      const segments = value.split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = segments.filter((s) => !isKnownSegment(s));
      if (unknown.length > 0) return { ok: false, reason: `unknown segment(s): ${unknown.join(', ')}` };
      writePreferences(ctx.agent.workspaceRoot, { statusline: segments.join(',') });
      return { ok: true, message: `statusline → ${segments.join(',')}` };
    },
  },
  effort: {
    get: (ctx) => `${resolveEffort(ctx.agent.workspaceRoot).effort} (${resolveEffort(ctx.agent.workspaceRoot).source})`,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['low', 'medium', 'high', 'xhigh'].includes(v)) return { ok: false, reason: `effort must be low|medium|high|xhigh (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { effort: v as EffortLevel });
      return { ok: true, message: `effort → ${v}` };
    },
  },
  mode: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).executionMode,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['planning', 'fast'].includes(v)) return { ok: false, reason: `mode must be planning|fast (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { executionMode: v as ExecutionMode });
      return { ok: true, message: `execution mode → ${v}` };
    },
  },
  'review-policy': {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).reviewPolicy,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['request', 'proceed'].includes(v)) return { ok: false, reason: `review-policy must be request|proceed (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { reviewPolicy: v as ReviewPolicy });
      return { ok: true, message: `review policy → ${v}` };
    },
  },
  quiet: {
    get: (ctx) => (readPreferences(ctx.agent.workspaceRoot).quiet ? 'on' : 'off'),
    set: (ctx, value) => {
      const v = value.toLowerCase();
      const on = ['on', 'true', '1', 'yes'].includes(v);
      const off = ['off', 'false', '0', 'no'].includes(v);
      if (!on && !off) return { ok: false, reason: `quiet must be on|off (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { quiet: on });
      setCliKnobOverride({ quiet: on });
      return { ok: true, message: `quiet → ${on ? 'on' : 'off'}` };
    },
  },
  personality: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).personality,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['concise', 'standard', 'detailed', 'pair-programmer'].includes(v)) {
        return { ok: false, reason: `personality must be concise|standard|detailed|pair-programmer (got "${value}")` };
      }
      writePreferences(ctx.agent.workspaceRoot, { personality: v as Preferences['personality'] });
      return { ok: true, message: `personality → ${v}` };
    },
  },
  editor: {
    get: (ctx) => readPreferences(ctx.agent.workspaceRoot).editorMode,
    set: (ctx, value) => {
      const v = value.toLowerCase();
      if (!['emacs', 'vi'].includes(v)) return { ok: false, reason: `editor must be emacs|vi (got "${value}")` };
      writePreferences(ctx.agent.workspaceRoot, { editorMode: v as Preferences['editorMode'] });
      return { ok: true, message: `editor → ${v} (restart to apply)` };
    },
  },
  model: {
    get: (ctx) => ctx.config.llm?.model ?? '(unset)',
    set: (ctx, value) => {
      if (!value.trim()) return { ok: false, reason: 'model name cannot be empty' };
      ctx.agent.setModel(value.trim());
      if (ctx.config.llm) {
        ctx.config.llm.model = value.trim();
        saveConfig(ctx.config);
        setSessionRuntime(ctx.agent.workspaceRoot, ctx.agent.sessionKey, { model: '' });
      }
      return { ok: true, message: `model → ${value.trim()}` };
    },
  },
  provider: {
    get: (ctx) => {
      return findDefaultProviderName(ctx) ?? '(not saved as a Provider)';
    },
    set: async (ctx, value) => {
      const name = value.trim();
      if (!setDefaultProvider(ctx, name)) {
        const known = listProviderNames(ctx.config);
        return { ok: false, reason: known.length ? `unknown Provider "${name}" — choose one of: ${known.join(', ')}` : 'no Providers configured — open /config and add one under Providers first' };
      }
      return { ok: true, message: `default provider → ${name} · ${ctx.config.llm?.model ?? ''}` };
    },
  },
  'automation': automationHandler('automation'),
  'automation.requirements': automationHandler('automation.requirements'),
  'automation.sync': automationHandler('automation.sync'),
  'automation.sprints': automationHandler('automation.sprints'),
  'web-search.provider': webSearchHandler('provider'),
  'web-search.serper-api-key': webSearchHandler('serperApiKey'),
  'web-search.google-api-key': webSearchHandler('googleApiKey'),
  'web-search.google-cx': webSearchHandler('googleCx'),
  'web-search.brave-api-key': webSearchHandler('braveApiKey'),
  'web-search.searxng-url': webSearchHandler('searxngBaseUrl'),
  'web-search.respect-robots': webSearchHandler('respectRobots'),
  'computer-use.enabled': computerUseHandler('enabled'),
  'computer-use.mode': computerUseHandler('mode'),
};

function printKey(ctx: CommandContext, key: string): void {
  const handler = KEY_HANDLERS[key];
  if (!handler) {
    console.log(chalk.red(`\n  Unknown config key "${key}".`));
    console.log(chalk.gray(`  Known keys: ${Object.keys(KEY_HANDLERS).join(', ')}.  Run /config (bare) for the interactive panel.\n`));
    return;
  }
  console.log(`\n  ${chalk.cyan(key)}: ${chalk.bold(handler.get(ctx))}\n`);
}

async function setKey(ctx: CommandContext, key: string, value: string): Promise<void> {
  const handler = KEY_HANDLERS[key];
  if (!handler || !handler.set) {
    console.log(chalk.red(`\n  /config can't set "${key}" directly.`));
    console.log(chalk.gray(`  Run /config (bare) and pick "${key}" interactively, or pick one of: ${Object.keys(KEY_HANDLERS).join(', ')}.\n`));
    return;
  }
  const result = await handler.set(ctx, value);
  if (!result.ok) {
    console.log(chalk.red(`\n  ✗ ${result.reason}\n`));
    return;
  }
  console.log(chalk.green(`\n  ✓ ${result.message}\n`));
}
