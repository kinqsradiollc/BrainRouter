import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { getConfigPath, saveConfig } from '../../config/config.js';
import {
  readPreferences,
  writePreferences,
  resolveEffort,
  type Preferences,
  type EffortLevel,
  type ExecutionMode,
  type ReviewPolicy,
} from '../../state/preferencesStore.js';
import { isKnownSegment, SEGMENT_NAMES } from '../statusline.js';
import { PROVIDER_CATALOG, findProvider, maskApiKey, validateApiKey } from '../wizard/providers.js';
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
 * Verb-overloaded (lifted from
 * `openSrc/DeepSeek-TUI/crates/tui/src/commands/config.rs:43`):
 *
 *   - `/config`              — open the settings home panel
 *   - `/config <key>`        — print the current value for <key>
 *   - `/config <key> <val>`  — set <key> to <val> and persist
 *   - `/config raw|json`     — print scrubbed JSON dump
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
    if (picked.key === '__raw') { printRawConfig(ctx); continue; }
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
      label: 'LLM provider',
      current: () => {
        const llm = config.llm;
        if (!llm) return '(not configured)';
        return `${llm.model} · ${shortenEndpoint(llm.endpoint)} · ${maskApiKey(llm.apiKey)}`;
      },
      edit: editLlm,
    },
    {
      key: 'mcp',
      label: 'MCP profile',
      current: () => {
        const profile = config.activeServer || '(none)';
        const server = config.servers[profile];
        if (!server) return profile;
        if (server.type === 'http') return `${profile} · http · ${server.url ?? ''}`;
        return `${profile} · stdio · ${server.command ?? ''}`;
      },
      edit: editMcp,
    },
    { key: 'theme',         label: 'Theme',            current: () => prefs().theme,                 edit: editTheme },
    { key: 'statusline',    label: 'Statusline',       current: () => prefs().statusline,            edit: editStatusline },
    { key: 'effort',        label: 'Reasoning effort', current: () => `${resolveEffort(agent.workspaceRoot).effort} (${resolveEffort(agent.workspaceRoot).source})`, edit: editEffort },
    { key: 'mode',          label: 'Execution mode',   current: () => prefs().executionMode,         edit: editExecutionMode },
    { key: 'review-policy', label: 'Review policy',    current: () => prefs().reviewPolicy,          edit: editReviewPolicy },
    { key: 'quiet',         label: 'Quiet mode',       current: () => prefs().quiet ? 'on' : 'off',  edit: toggleQuiet },
    { key: 'personality',   label: 'Personality',      current: () => prefs().personality,           edit: editPersonality },
    { key: 'editor',        label: 'Editor mode',      current: () => prefs().editorMode,            edit: editEditorMode },
    { key: '__raw',         label: 'View raw config',  current: () => 'JSON dump',                   edit: async () => false },
    { key: '__exit',        label: 'Quit (esc)',       current: () => '',                            edit: async () => false },
  ];
}

function shortenEndpoint(url?: string): string {
  if (!url) return 'default endpoint';
  return url.replace(/^https?:\/\//, '').replace(/\/v1.*$/, '').replace(/\/api\/v1.*$/, '');
}

// --- Per-row editors ---------------------------------------------------

function themeFor(ctx: CommandContext): Theme {
  const mode = readPreferences(ctx.agent.workspaceRoot).theme;
  return buildTheme(mode === 'mono' ? 'mono' : mode === 'light' ? 'light' : 'dark');
}

async function editLlm(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
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
  if (provResult.kind !== 'pick') return false;
  const provider = PROVIDER_CATALOG.find((p) => p.id === provResult.id);
  if (!provider) return false;
  const envValue = process.env[provider.envKey] ?? ctx.config.llm?.apiKey ?? '';
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
  if (keyResult.kind !== 'accept') return false;
  const modelResult = await pickFromList({
    theme,
    title: 'Model',
    subtitle: `Pick the chat model for ${provider.label}.`,
    rows: provider.models.map((m) => ({ id: m, label: m, value: m === provider.defaultModel ? 'default' : '' })),
    initialCursor: Math.max(0, provider.models.indexOf(provider.defaultModel)),
    allowOther: true,
    otherLabel: 'Other model',
    otherDescription: 'Type any model name supported by this endpoint',
  });
  if (modelResult.kind === 'cancelled') return false;
  const model = modelResult.kind === 'other' ? modelResult.text.trim() : modelResult.id;
  ctx.config.llm = {
    provider: 'openai',
    apiKey: keyResult.text,
    model: model || provider.defaultModel,
    endpoint: provider.endpoint,
  };
  saveConfig(ctx.config);
  ctx.agent.setModel(model || provider.defaultModel);
  console.log(chalk.green(`\n  ✓ LLM saved: ${provider.label} · ${model || provider.defaultModel} · ${maskApiKey(keyResult.text)}`));
  console.log(chalk.gray('    Endpoint changes take effect on the next CLI restart.\n'));
  return true;
}

async function editMcp(ctx: CommandContext): Promise<boolean> {
  const theme = themeFor(ctx);
  const result = await pickFromList({
    theme,
    title: 'MCP profile',
    subtitle: 'Pick how the CLI reaches the BrainRouter MCP.',
    rows: [
      { id: 'local-stdio', label: 'Local stdio', value: 'brainrouter-mcp', description: 'No HTTP server needed' },
      { id: 'local-http',  label: 'Local HTTP',  value: 'localhost:3747', description: 'Connect to a local brainrouter-mcp HTTP server' },
      { id: 'remote-http', label: 'Remote HTTP', value: 'custom URL',     description: 'Connect to a hosted MCP server (URL + optional key)' },
    ],
  });
  if (result.kind !== 'pick') return false;
  if (result.id === 'local-stdio') {
    ctx.config.servers['local-stdio'] = { type: 'stdio', command: 'brainrouter-mcp', args: [], identity: 'brainrouter' };
    ctx.config.activeServer = 'local-stdio';
  } else if (result.id === 'local-http') {
    ctx.config.servers['local-http'] = { type: 'http', url: 'http://localhost:3747/mcp', identity: 'brainrouter' };
    ctx.config.activeServer = 'local-http';
  } else {
    const urlResult = await promptText({
      theme,
      title: 'Remote MCP URL',
      subtitle: 'Paste the full URL (e.g. https://brainrouter.example.com/mcp).',
      badge: 'MCP',
      prefilled: '',
      placeholder: 'https://...',
      validate: (raw) => {
        const v = raw.trim();
        if (!v) return 'URL required';
        try { new URL(v); } catch { return 'not a valid URL'; }
        return undefined;
      },
    });
    if (urlResult.kind !== 'accept') return false;
    ctx.config.servers['remote'] = { type: 'http', url: urlResult.text.trim(), identity: 'brainrouter' };
    ctx.config.activeServer = 'remote';
  }
  saveConfig(ctx.config);
  console.log(chalk.green(`\n  ✓ MCP profile saved as active.`));
  console.log(chalk.gray('    Run /mcp reconnect to pick up the change without restarting.\n'));
  return true;
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
  if (next) process.env.BRAINROUTER_QUIET = '1';
  else delete process.env.BRAINROUTER_QUIET;
  console.log(chalk.green(`\n  ✓ Quiet mode → ${next ? 'on' : 'off'}\n`));
  return true;
}

// --- get / set entrypoints ---------------------------------------------

function printRawConfig(ctx: CommandContext): void {
  console.log(chalk.bold('\n⚙️  Active Configuration:'));
  console.log(`  File Path: ${chalk.blue(getConfigPath())}\n`);
  const scrubbed = JSON.parse(JSON.stringify(ctx.config));
  if (scrubbed.llm?.apiKey) scrubbed.llm.apiKey = maskApiKey(scrubbed.llm.apiKey);
  for (const s of Object.values(scrubbed.servers ?? {})) {
    const srv = s as any;
    if (srv.apiKey) srv.apiKey = maskApiKey(srv.apiKey);
    if (srv.env?.BRAINROUTER_API_KEY) srv.env.BRAINROUTER_API_KEY = maskApiKey(srv.env.BRAINROUTER_API_KEY);
  }
  console.log(chalk.gray(JSON.stringify(scrubbed, null, 2)));
  console.log();
}

interface ConfigKeyHandler {
  get: (ctx: CommandContext) => string;
  set?: (ctx: CommandContext, value: string) => { ok: true; message: string } | { ok: false; reason: string };
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
      if (!['low', 'medium', 'high'].includes(v)) return { ok: false, reason: `effort must be low|medium|high (got "${value}")` };
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
      if (on) process.env.BRAINROUTER_QUIET = '1';
      else delete process.env.BRAINROUTER_QUIET;
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
      }
      return { ok: true, message: `model → ${value.trim()}` };
    },
  },
  provider: {
    get: (ctx) => {
      const llm = ctx.config.llm;
      if (!llm) return '(unset)';
      const match = PROVIDER_CATALOG.find((p) => p.endpoint === llm.endpoint);
      return match?.id ?? 'custom';
    },
    set: (ctx, value) => {
      const provider = findProvider(value.trim().toLowerCase());
      if (!provider) return { ok: false, reason: `unknown provider id "${value}" — open /config (bare) and pick interactively` };
      ctx.config.llm = {
        provider: 'openai',
        apiKey: ctx.config.llm?.apiKey ?? '',
        model: provider.defaultModel,
        endpoint: provider.endpoint,
      };
      saveConfig(ctx.config);
      return { ok: true, message: `provider → ${provider.label} (model defaulted to ${provider.defaultModel})` };
    },
  },
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
  const result = handler.set(ctx, value);
  if (!result.ok) {
    console.log(chalk.red(`\n  ✗ ${result.reason}\n`));
    return;
  }
  console.log(chalk.green(`\n  ✓ ${result.message}\n`));
}
