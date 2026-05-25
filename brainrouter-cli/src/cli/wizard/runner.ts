import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { NoTTYError } from '../cliPrompt.js';
import { writePreferences } from '../../state/preferencesStore.js';
import {
  loadOrInitConfig,
  saveConfig,
  type Config,
} from '../../config/config.js';
import { initAgentMd } from '../../prompt/initAgentMd.js';
import { McpClientWrapper } from '../../runtime/mcpClient.js';
import {
  PROVIDER_CATALOG,
  type ProviderEntry,
  detectProviderFromEnv,
  validateApiKey,
  maskApiKey,
} from './providers.js';
import {
  initWizardState,
  reduceWizard,
  type McpPick,
  type Step,
  type WizardDraft,
  type WizardState,
} from './types.js';
import { pickFromList, promptText, type PickerRow } from './picker.js';
import { selectModel } from './modelsApi.js';
import { buildTheme, type Theme, type ThemeMode } from '../theme.js';

/**
 * 0.3.7 onboarding wizard — drives the Step state machine over the new
 * internal picker (`./picker.ts`) which renders atomically and never
 * has external stdout writes mid-step. Fixes the redraw-stacking bug
 * the original `askChoice`-based wizard hit on every cursor move.
 *
 * Two entry modes (unchanged from the original design):
 *
 *   1. **First-run auto-trigger** — `index.ts` calls
 *      `runWizard({ ownsReadline: true })` BEFORE constructing the
 *      Agent / McpClient when `~/.config/brainrouter/config.json` is
 *      missing.
 *   2. **`/init`** from inside the REPL — `runWizard({ ownsReadline:
 *      false })` reuses the REPL's existing readline.
 */

const ONBOARDED_MARKER = path.join(os.homedir(), '.config', 'brainrouter', '.onboarded');

export function isOnboarded(): boolean {
  try { return fs.existsSync(ONBOARDED_MARKER); } catch { return false; }
}

export function markOnboarded(): void {
  try {
    fs.mkdirSync(path.dirname(ONBOARDED_MARKER), { recursive: true });
    fs.writeFileSync(ONBOARDED_MARKER, '', 'utf8');
  } catch {
    /* non-fatal */
  }
}

export interface WizardRunOptions {
  ownsReadline: boolean;
  workspaceRoot: string;
}

export interface WizardRunResult {
  state: WizardState;
  config?: Config;
}

const TOTAL_STEPS = 6; // theme, provider, apiKey, model, mcp, agentMd

function progressBadge(step: Step): string | undefined {
  const decisionSteps: Step[] = ['theme', 'provider', 'apiKey', 'model', 'mcp', 'agentMd'];
  const idx = decisionSteps.indexOf(step);
  if (idx < 0) return undefined;
  return `Step ${idx + 1} of ${TOTAL_STEPS}`;
}

export async function runWizard(opts: WizardRunOptions): Promise<WizardRunResult> {
  if (opts.ownsReadline && !process.stdin.isTTY) {
    throw new NoTTYError(
      'BrainRouter has no config and stdin is not a TTY — run `brainrouter` in an interactive terminal at least once to complete the setup wizard.',
    );
  }

  let state = initWizardState();
  let theme = buildTheme('dark');

  while (!state.committed && !state.aborted) {
    const before = state.draft.theme;
    state = await runStep(state, opts, theme);
    if (state.draft.theme && state.draft.theme !== before) {
      theme = buildTheme(state.draft.theme);
    }
  }

  let savedConfig: Config | undefined;
  if (state.committed) {
    savedConfig = commitWizardDraft(state.draft, opts.workspaceRoot);
    markOnboarded();
    renderDoneSummary(state, savedConfig, theme);
  } else if (state.aborted) {
    process.stdout.write(theme.warning('\n  Wizard aborted — no changes saved.\n\n'));
  }
  return { state, config: savedConfig };
}

async function runStep(state: WizardState, opts: WizardRunOptions, theme: Theme): Promise<WizardState> {
  switch (state.currentStep) {
    case 'welcome':  return runWelcomeStep(state, theme);
    case 'theme':    return runThemeStep(state, opts.workspaceRoot);
    case 'provider': return runProviderStep(state, theme);
    case 'apiKey':   return runApiKeyStep(state, theme);
    case 'model':    return runModelStep(state, theme);
    case 'mcp':      return runMcpStep(state, theme);
    case 'agentMd':  return runAgentMdStep(state, opts.workspaceRoot, theme);
    case 'done':     return reduceWizard(state, { kind: 'commit' });
  }
}

// --- Welcome -----------------------------------------------------------

async function runWelcomeStep(state: WizardState, theme: Theme): Promise<WizardState> {
  const result = await pickFromList({
    theme,
    title: '🧠  BrainRouter',
    subtitle: 'A memory-native coding agent that runs in your terminal. This wizard takes ~60 seconds and writes to ~/.config/brainrouter/config.json plus <workspace>/.brainrouter/cli/preferences.json. Press ENTER to start, q to abort.',
    rows: [
      { id: 'start', label: 'Start setup', description: 'Theme → Provider → API key → Model → MCP → AGENT.md' },
      { id: 'abort', label: 'Abort', description: 'Exit without saving anything' },
    ],
    badge: 'Welcome',
    eraseOnClose: true,
  });
  if (result.kind !== 'pick' || result.id === 'abort') return reduceWizard(state, { kind: 'abort' });
  return reduceWizard(state, { kind: 'advance', patch: {} });
}

// --- Theme -------------------------------------------------------------

async function runThemeStep(state: WizardState, workspaceRoot: string): Promise<WizardState> {
  const themes: { id: ThemeMode; label: string; description: string }[] = [
    { id: 'dark',  label: 'Dark',  description: 'Default · saturated accents on a black terminal' },
    { id: 'light', label: 'Light', description: 'Darker accents for white terminals (solarized-light, GitHub light)' },
    { id: 'mono',  label: 'Mono',  description: 'No color · screenshots, CI logs, pipe-to-less' },
  ];

  const result = await pickFromList({
    theme: buildTheme('dark'),
    title: 'Theme',
    subtitle: 'Pick a color palette. Arrow keys live-preview the prompt accent inside this panel.',
    badge: progressBadge('theme'),
    rows: themes.map((t) => ({ id: t.id, label: t.label, description: t.description })),
    initialCursor: 0,
    onCursorChange: (id) => {
      const preview = buildTheme(id as ThemeMode);
      return [
        preview.muted('preview › ') + preview.primary('brainrouter>') + ' ' + preview.heading('sample prompt') + '  ' + preview.muted('with ') + preview.success('success') + preview.muted(' and ') + preview.danger('danger') + preview.muted(' accents'),
      ];
    },
    eraseOnClose: true,
  });
  if (result.kind !== 'pick') return reduceWizard(state, { kind: 'abort' });
  const mode = result.id as ThemeMode;
  try { writePreferences(workspaceRoot, { theme: mode }); } catch { /* non-fatal */ }
  return reduceWizard(state, { kind: 'advance', patch: { theme: mode } });
}

// --- Provider ----------------------------------------------------------

async function runProviderStep(state: WizardState, theme: Theme): Promise<WizardState> {
  const detected = detectProviderFromEnv();
  const rows: PickerRow[] = PROVIDER_CATALOG.map((p) => {
    const envHit = !!process.env[p.envKey];
    const status = envHit ? 'env detected' : p.local ? 'local · key optional' : 'needs API key';
    return {
      id: p.id,
      label: p.label,
      value: status,
      description: p.hint,
    };
  });
  const initialCursor = detected
    ? Math.max(0, PROVIDER_CATALOG.findIndex((p) => p.id === detected.id))
    : 0;

  const result = await pickFromList({
    theme,
    title: 'LLM provider',
    subtitle: detected
      ? `Detected ${detected.envKey} in your shell — ${detected.label} is pre-selected. Pick "Other" to enter a custom OpenAI-compatible endpoint.`
      : 'Pick the LLM provider for the chat agent. Pick "Other" to enter a custom OpenAI-compatible endpoint.',
    badge: progressBadge('provider'),
    rows,
    initialCursor,
    allowOther: true,
    otherLabel: 'Other endpoint',
    otherDescription: 'OpenAI-compatible /v1/chat/completions URL',
    eraseOnClose: true,
  });
  if (result.kind === 'cancelled') return reduceWizard(state, { kind: 'abort' });
  if (result.kind === 'other') {
    const url = result.text;
    if (!url) return state;
    const ad: ProviderEntry = {
      id: 'custom',
      label: 'Custom endpoint',
      hint: url,
      endpoint: url,
      envKey: 'BRAINROUTER_LLM_API_KEY',
      local: /localhost|127\.0\.0\.1|::1|0\.0\.0\.0/.test(url),
      models: [],
      defaultModel: 'gpt-4o-mini',
    };
    return reduceWizard(state, {
      kind: 'advance',
      patch: { provider: ad, customEndpoint: url },
    });
  }
  const provider = PROVIDER_CATALOG.find((p) => p.id === result.id);
  if (!provider) return state;
  return reduceWizard(state, { kind: 'advance', patch: { provider } });
}

// --- API key -----------------------------------------------------------

async function runApiKeyStep(state: WizardState, theme: Theme): Promise<WizardState> {
  const provider = state.draft.provider;
  if (!provider) return reduceWizard(state, { kind: 'back' });
  const envValue = process.env[provider.envKey] ?? '';
  const subtitle = envValue
    ? `${provider.envKey} is set in your shell — press ENTER to accept, or type a different key.`
    : provider.local
      ? `${provider.label} is local — a blank API key is fine (just press ENTER).`
      : `Paste your ${provider.label} API key. Stored at ~/.config/brainrouter/config.json.`;

  const result = await promptText({
    theme,
    title: 'API key',
    subtitle,
    badge: `${progressBadge('apiKey')} · ${provider.label}`,
    prefilled: envValue,
    mask: false, // we mask on display in the summary; while typing the user benefits from seeing chars
    placeholder: provider.local ? '(blank OK for local endpoints)' : 'paste your API key here',
    validate: (raw) => {
      const verdict = validateApiKey(raw, provider);
      if (verdict.kind === 'reject') return verdict.reason;
      return undefined;
    },
    eraseOnClose: true,
  });
  if (result.kind === 'cancelled') return reduceWizard(state, { kind: 'abort' });
  const key = result.text;
  const verdict = validateApiKey(key, provider);
  let next = state;
  if (verdict.kind === 'accept' && verdict.warning) {
    next = reduceWizard(next, { kind: 'warn', message: verdict.warning });
  }
  return reduceWizard(next, { kind: 'advance', patch: { apiKey: key } });
}

// --- Model -------------------------------------------------------------

async function runModelStep(state: WizardState, theme: Theme): Promise<WizardState> {
  const provider = state.draft.provider;
  if (!provider) return reduceWizard(state, { kind: 'back' });
  // Wizard delegates to the shared `selectModel` so the in-REPL
  // `/model` quick-swap and onboarding pick from the same UI. The
  // wizard wraps the picker's "current model" semantic differently:
  // here there's no current model yet (we're CREATING the config),
  // so we pass undefined and the helper opens the cursor on the
  // provider default. `eraseOnClose: true` keeps the wizard's frame
  // hygiene (each step blanks itself before the next renders).
  const result = await selectModel({
    theme,
    provider,
    apiKey: state.draft.apiKey ?? '',
    endpointOverride: state.draft.customEndpoint,
    title: 'Model',
    badge: progressBadge('model'),
    eraseOnClose: true,
  });
  if (!result) return reduceWizard(state, { kind: 'abort' });
  return reduceWizard(state, { kind: 'advance', patch: { model: result.model || provider.defaultModel } });
}

// --- MCP ---------------------------------------------------------------

async function runMcpStep(state: WizardState, theme: Theme): Promise<WizardState> {
  type Row = PickerRow & { pick: McpPick };
  const rows: Row[] = [
    { id: 'local-stdio',  label: 'Local stdio',  value: 'spawn brainrouter-mcp', description: 'No HTTP server needed — the CLI spawns the MCP child', pick: { kind: 'local-stdio' } },
    { id: 'local-http',   label: 'Local HTTP',   value: 'http://localhost:3747', description: 'Connect to a brainrouter-mcp HTTP server running locally', pick: { kind: 'local-http' } },
    { id: 'remote-http',  label: 'Remote HTTP',  value: 'custom URL',            description: 'Connect to a hosted BrainRouter MCP (URL + optional key)', pick: { kind: 'remote-http', url: '' } },
    { id: 'skip',         label: 'Skip',         value: 'no MCP',               description: 'Local tools only · no recall, skills, or capture', pick: { kind: 'skip' } },
  ];
  const result = await pickFromList({
    theme,
    title: 'MCP server',
    subtitle: 'BrainRouter\'s memory + skills live behind an MCP server. Pick how to reach it.',
    badge: progressBadge('mcp'),
    rows,
    initialCursor: 0,
    eraseOnClose: true,
  });
  if (result.kind === 'cancelled') return reduceWizard(state, { kind: 'abort' });
  if (result.kind !== 'pick') return state;
  const picked = rows.find((r) => r.id === result.id)?.pick;
  if (!picked) return state;

  let final: McpPick = picked;
  if (final.kind === 'remote-http') {
    const urlResult = await promptText({
      theme,
      title: 'Remote MCP URL',
      subtitle: 'Paste the full URL (e.g. https://brainrouter.example.com/mcp). Press Esc to back out.',
      badge: 'MCP',
      prefilled: '',
      placeholder: 'https://...',
      validate: (raw) => {
        const v = raw.trim();
        if (!v) return 'URL is required';
        try { new URL(v); } catch { return 'not a valid URL'; }
        return undefined;
      },
      eraseOnClose: true,
    });
    if (urlResult.kind === 'cancelled') return reduceWizard(state, { kind: 'abort' });
    final = { kind: 'remote-http', url: urlResult.text.trim() };
  }

  const probe = await probeMcp(final, state.draft);
  if (probe.warning) {
    const next = reduceWizard(state, { kind: 'warn', message: probe.warning });
    return reduceWizard(next, { kind: 'advance', patch: { mcp: final } });
  }
  return reduceWizard(state, { kind: 'advance', patch: { mcp: final } });
}

async function probeMcp(pick: McpPick, draft: WizardDraft): Promise<{ ok: boolean; warning?: string }> {
  if (pick.kind === 'skip') return { ok: true };
  const wrapper = new McpClientWrapper();
  const llmConfig = draft.provider && draft.model
    ? { provider: 'openai' as const, apiKey: draft.apiKey ?? '', model: draft.model, endpoint: draft.customEndpoint ?? draft.provider.endpoint }
    : undefined;
  const serverConfig = mcpPickToServerConfig(pick);
  if (!serverConfig) return { ok: false, warning: 'Could not build MCP server config for this pick.' };
  try {
    await Promise.race([
      wrapper.connect(serverConfig, llmConfig, 'wizard'),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('probe timed out after 5s')), 5_000)),
    ]);
    await wrapper.close();
    return { ok: true };
  } catch (err: any) {
    try { await wrapper.close(); } catch { /* ignore */ }
    return {
      ok: false,
      warning: `MCP probe failed (${err?.message ?? err}). Profile saved — start the server and run /mcp reconnect later.`,
    };
  }
}

function mcpPickToServerConfig(pick: McpPick) {
  if (pick.kind === 'local-stdio') {
    return { type: 'stdio' as const, command: 'brainrouter-mcp', args: [], identity: 'brainrouter' as const };
  }
  if (pick.kind === 'local-http') {
    return { type: 'http' as const, url: 'http://localhost:3747/mcp', identity: 'brainrouter' as const };
  }
  if (pick.kind === 'remote-http') {
    return { type: 'http' as const, url: pick.url, apiKey: pick.apiKey, identity: 'brainrouter' as const };
  }
  return undefined;
}

// --- AGENT.md ----------------------------------------------------------

async function runAgentMdStep(state: WizardState, workspaceRoot: string, theme: Theme): Promise<WizardState> {
  const agentMdPath = path.join(workspaceRoot, 'AGENT.md');
  const claudeMdPath = path.join(workspaceRoot, 'CLAUDE.md');
  const exists = fs.existsSync(agentMdPath) || fs.existsSync(claudeMdPath);
  const result = await pickFromList({
    theme,
    title: 'AGENT.md',
    subtitle: exists
      ? 'Workspace already has AGENT.md / CLAUDE.md — skipping by default. Pick "Overwrite" only if you really want to replace it.'
      : 'AGENT.md gives every coding agent (Claude Code, Codex, BrainRouter, …) a single hub of repo conventions. Recommended.',
    badge: progressBadge('agentMd'),
    rows: exists
      ? [
          { id: 'skip',     label: 'Skip',     value: 'keep existing file', description: 'Leave the current AGENT.md / CLAUDE.md alone' },
          { id: 'write',    label: 'Overwrite', value: 'replace contents',  description: 'Drop the starter template over the existing file' },
        ]
      : [
          { id: 'write', label: 'Write AGENT.md', value: 'recommended', description: 'Scaffold a starter template in the workspace root' },
          { id: 'skip',  label: 'Skip',           value: 'no file',    description: 'Write AGENT.md manually later' },
        ],
    initialCursor: 0,
    eraseOnClose: true,
  });
  if (result.kind === 'cancelled') return reduceWizard(state, { kind: 'abort' });
  if (result.kind !== 'pick') return state;
  return reduceWizard(state, {
    kind: 'advance',
    patch: { writeAgentMd: result.id === 'write' },
  });
}

// --- Commit + summary --------------------------------------------------

function commitWizardDraft(draft: WizardDraft, workspaceRoot: string): Config {
  const config = loadOrInitConfig();
  if (draft.provider) {
    config.llm = {
      provider: 'openai',
      apiKey: draft.apiKey ?? '',
      model: draft.model ?? draft.provider.defaultModel,
      endpoint: draft.customEndpoint ?? draft.provider.endpoint,
    };
  }
  if (draft.mcp && draft.mcp.kind !== 'skip') {
    const profileName = draft.mcp.kind === 'remote-http' ? 'remote' : draft.mcp.kind === 'local-http' ? 'local-http' : 'local-stdio';
    const serverConfig = mcpPickToServerConfig(draft.mcp);
    if (serverConfig) {
      config.servers[profileName] = serverConfig;
      config.activeServer = profileName;
    }
  } else if (draft.mcp?.kind === 'skip') {
    // Skip means skip — clear any previously-active profile so the CLI doesn't
    // silently re-spawn an MCP child from a stale config. The user can re-add
    // a profile via `/login` later.
    config.activeServer = '';
  }
  saveConfig(config);
  if (draft.theme) {
    try { writePreferences(workspaceRoot, { theme: draft.theme }); } catch { /* non-fatal */ }
  }
  if (draft.writeAgentMd) {
    try { initAgentMd(workspaceRoot); } catch { /* non-fatal */ }
  }
  return config;
}

function renderDoneSummary(state: WizardState, _config: Config, theme: Theme): void {
  const lines: string[] = [
    '',
    theme.heading('  ✓  Setup complete'),
    '',
    `    ${theme.muted('theme')}    ${theme.plain(state.draft.theme ?? 'dark')}`,
    `    ${theme.muted('provider')} ${theme.plain(state.draft.provider?.label ?? '(unset)')}`,
    `    ${theme.muted('model')}    ${theme.plain(state.draft.model ?? '(unset)')}`,
    `    ${theme.muted('api key')}  ${theme.plain(maskApiKey(state.draft.apiKey ?? ''))}`,
    `    ${theme.muted('mcp')}      ${theme.plain(formatMcpForSummary(state.draft.mcp))}`,
    `    ${theme.muted('agent.md')} ${theme.plain(state.draft.writeAgentMd ? 'written' : 'skipped')}`,
    '',
    theme.muted('  Config saved to ~/.config/brainrouter/config.json.'),
    theme.muted('  Re-run any time with /init.  Tweak individual knobs with /config.'),
  ];
  if (state.warnings.length > 0) {
    lines.push('');
    lines.push(theme.warning('  Advisories:'));
    for (const w of state.warnings) {
      lines.push(`    ${theme.warning('!')} ${w.message}`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n\n');
}

function formatMcpForSummary(pick?: McpPick): string {
  if (!pick) return '(unset)';
  if (pick.kind === 'local-stdio') return 'local stdio (brainrouter-mcp)';
  if (pick.kind === 'local-http') return 'local http (http://localhost:3747/mcp)';
  if (pick.kind === 'remote-http') return `remote · ${pick.url}`;
  return 'skipped (offline-only)';
}
