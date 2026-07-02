// Per-row editors for the /config settings panel: the provider/model/web-search/
// agent-models/theme/statusline/effort/mode/personality/wire-format editors, the
// shared provider→key→endpoint→model gather flow, and the BrainRouter MCP key
// prompt. MCP profile management lives in ./mcpProfiles.ts.
import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { saveConfig, getCliKnobs, setCliKnobOverride, _resetCliKnobsCache, type LLMConfig } from '@kinqs/brainrouter-core/config';
import {
  listProviderNames, setProvider, removeProvider, setAgentModel, describeAgentModel, SUBAGENT_ROLES,
  PROVIDER_CATALOG, maskApiKey, validateApiKey,
} from '@kinqs/brainrouter-core/provider';
import {
  readPreferences,
  writePreferences,
  type Preferences,
  type EffortLevel,
  type ExecutionMode,
  type ReviewPolicy,
} from '@kinqs/brainrouter-core/session';
import { isKnownSegment, SEGMENT_NAMES } from '../../statusline.js';
import { selectModel } from '../../wizard/modelsApi.js';
import type { PickerRow } from '../../ink/runPicker.js';
import type { Theme } from '../../theme.js';
import {
  pickFromList, promptText, themeFor, shortenEndpoint, findDefaultProviderName,
  setDefaultProvider, subagentRoleLabel, setAgentModelNormalized, ensureWebSearchConfig,
} from './shared.js';
import {
  listProviderRequestFormatRows, applyProviderRequestFormat,
  WIRE_FORMAT_OPTIONS, type WireFormatOption,
} from './wireFormat.js';

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

export async function editDefaultProvider(ctx: CommandContext): Promise<boolean> {
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
export async function editProviders(ctx: CommandContext): Promise<boolean> {
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

export async function editWebSearch(ctx: CommandContext): Promise<boolean> {
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
export async function editAgentModels(ctx: CommandContext): Promise<boolean> {
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
export async function editWireFormat(ctx: CommandContext): Promise<boolean> {
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

export async function editTheme(ctx: CommandContext): Promise<boolean> {
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

export async function editStatusline(ctx: CommandContext): Promise<boolean> {
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

export async function editEffort(ctx: CommandContext): Promise<boolean> {
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

export async function editExecutionMode(ctx: CommandContext): Promise<boolean> {
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

export async function editReviewPolicy(ctx: CommandContext): Promise<boolean> {
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

export async function editPersonality(ctx: CommandContext): Promise<boolean> {
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

export async function editEditorMode(ctx: CommandContext): Promise<boolean> {
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

export async function toggleQuiet(ctx: CommandContext): Promise<boolean> {
  const current = readPreferences(ctx.agent.workspaceRoot).quiet;
  const next = !current;
  writePreferences(ctx.agent.workspaceRoot, { quiet: next });
  setCliKnobOverride({ quiet: next });
  console.log(chalk.green(`\n  ✓ Quiet mode → ${next ? 'on' : 'off'}\n`));
  return true;
}
