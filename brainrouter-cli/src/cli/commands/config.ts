import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { askChoice, CancelledChoiceError } from '../cliPrompt.js';
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

/**
 * `/config` slash command — 0.3.7 redesign.
 *
 * Verb-overloaded, lifted from
 * `openSrc/DeepSeek-TUI/crates/tui/src/commands/config.rs:43`:
 *
 *   - `/config` (bare) — open the **settings home panel** (picker over
 *     every CLI knob; selecting a row opens its sub-picker; Esc returns
 *     to the home; Esc on the home exits).
 *   - `/config <key>` — print the current value for `<key>`.
 *   - `/config <key> <value>` — set `<key>` to `<value>` and persist.
 *   - `/config raw` — print the scrubbed JSON config (the
 *     pre-0.3.7 bare-`/config` behaviour, preserved under a name so
 *     users who scripted around it still have a path).
 *
 * Persistence routes through `saveConfig` / `writePreferences` — never
 * touches JSON files directly so future schema changes stay
 * centralized.
 */

// --- Public entrypoint -------------------------------------------------

/**
 * Pure parser for `/config` arguments. Decoupled from the dispatcher so
 * the test suite can pin the routing table without driving the picker.
 *
 *   /config                  → { mode: 'home' }
 *   /config raw              → { mode: 'raw' }
 *   /config --raw            → { mode: 'raw' }
 *   /config json             → { mode: 'raw' }
 *   /config theme            → { mode: 'get',  key: 'theme' }
 *   /config theme dark       → { mode: 'set',  key: 'theme', value: 'dark' }
 *   /config statusline a,b,c → { mode: 'set',  key: 'statusline', value: 'a,b,c' }
 */
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

/** Exposed for tests — KEY_HANDLERS shape is otherwise an internal detail. */
export function listKnownConfigKeys(): string[] {
  return Object.keys(KEY_HANDLERS);
}

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

// --- Settings home panel -----------------------------------------------

interface PanelRow {
  key: string;
  label: string;
  current: () => string;
  /** Returns true when the value changed (caller refreshes the panel). */
  edit: (ctx: CommandContext) => Promise<boolean>;
}

async function runHomePanel(ctx: CommandContext): Promise<void> {
  const { agent } = ctx;
  let cursor = 0;
  while (true) {
    const rows = buildPanelRows(ctx);
    const longest = rows.reduce((w, r) => Math.max(w, r.label.length), 0);
    const choices = rows.map((row) => ({
      label: row.label,
      description: padRight(row.current(), 50, longest > 18 ? 28 : 32),
    }));
    let answer: string | string[];
    try {
      answer = await askChoice(
        `Edit which setting? (workspace: ${agent.workspaceRoot})`,
        choices,
        { header: '⚙️  /config', initialCursor: cursor },
      );
    } catch (err) {
      if (err instanceof CancelledChoiceError) return;
      throw err;
    }
    const pickedRow = rows.find((r) => r.label === answer);
    if (!pickedRow) {
      // "Other" or unknown — treat as exit.
      return;
    }
    cursor = rows.indexOf(pickedRow);
    if (pickedRow.key === '__exit') return;
    if (pickedRow.key === '__raw') { printRawConfig(ctx); continue; }
    try {
      await pickedRow.edit(ctx);
    } catch (err: any) {
      console.log(chalk.red(`\n  /config "${pickedRow.label}" failed: ${err?.message ?? err}\n`));
    }
  }
}

function padRight(s: string, max: number, target = 32): string {
  const clipped = s.length > max ? s.slice(0, max - 1) + '…' : s;
  return clipped.length >= target ? clipped : clipped + ' '.repeat(target - clipped.length);
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
        return `${llm.model}  ·  ${shortenEndpoint(llm.endpoint)}  ·  ${maskApiKey(llm.apiKey)}`;
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
        if (server.type === 'http') return `${profile}  ·  http  ·  ${server.url ?? ''}`;
        return `${profile}  ·  stdio  ·  ${server.command ?? ''}`;
      },
      edit: editMcp,
    },
    {
      key: 'theme',
      label: 'Theme',
      current: () => prefs().theme,
      edit: editTheme,
    },
    {
      key: 'statusline',
      label: 'Statusline',
      current: () => prefs().statusline,
      edit: editStatusline,
    },
    {
      key: 'effort',
      label: 'Reasoning effort',
      current: () => `${resolveEffort(agent.workspaceRoot).effort}  (${resolveEffort(agent.workspaceRoot).source})`,
      edit: editEffort,
    },
    {
      key: 'mode',
      label: 'Execution mode',
      current: () => prefs().executionMode,
      edit: editExecutionMode,
    },
    {
      key: 'review-policy',
      label: 'Review policy',
      current: () => prefs().reviewPolicy,
      edit: editReviewPolicy,
    },
    {
      key: 'quiet',
      label: 'Quiet mode',
      current: () => (prefs().quiet ? 'on' : 'off'),
      edit: toggleBool('quiet'),
    },
    {
      key: 'personality',
      label: 'Personality',
      current: () => prefs().personality,
      edit: editPersonality,
    },
    {
      key: 'editor',
      label: 'Editor mode',
      current: () => prefs().editorMode,
      edit: editEditorMode,
    },
    {
      key: '__raw',
      label: 'View raw config',
      current: () => chalk.gray('dump scrubbed JSON'),
      edit: async () => false,
    },
    {
      key: '__exit',
      label: 'Quit (Esc)',
      current: () => '',
      edit: async () => false,
    },
  ];
}

function shortenEndpoint(url?: string): string {
  if (!url) return 'default endpoint';
  return url
    .replace(/^https?:\/\//, '')
    .replace(/\/v1.*$/, '')
    .replace(/\/api\/v1.*$/, '');
}

// --- Per-row editors ---------------------------------------------------

async function editLlm(ctx: CommandContext): Promise<boolean> {
  const rows = PROVIDER_CATALOG.map((p) => ({
    label: p.label,
    description: p.hint,
  }));
  try {
    const pick = await askChoice('Which LLM provider?', rows, { header: 'Provider' });
    const provider = PROVIDER_CATALOG.find((p) => p.label === pick);
    if (!provider) return false;
    const envValue = process.env[provider.envKey] ?? ctx.config.llm?.apiKey ?? '';
    const keyAnswer = await askChoice(
      `${provider.label} API key:`,
      [{ label: 'Skip (local endpoint, no key)', description: 'Use a blank key — only for LM Studio / Ollama / custom local' }],
      { header: 'API key', prefilledOther: envValue },
    );
    let key = typeof keyAnswer === 'string' ? keyAnswer.trim() : '';
    if (key === 'Skip (local endpoint, no key)') key = '';
    const verdict = validateApiKey(key, provider);
    if (verdict.kind === 'reject') {
      console.log(chalk.red(`  ✗  ${verdict.reason}\n`));
      return false;
    }
    if (verdict.kind === 'accept' && verdict.warning) {
      console.log(chalk.yellow(`  !  ${verdict.warning}\n`));
    }
    const modelAnswer = await askChoice(
      `${provider.label} model:`,
      provider.models.map((m) => ({ label: m, description: m === provider.defaultModel ? '(default)' : '' })),
      { header: 'Model', initialCursor: Math.max(0, provider.models.indexOf(provider.defaultModel)) },
    );
    const model = typeof modelAnswer === 'string' ? modelAnswer.trim() || provider.defaultModel : provider.defaultModel;
    ctx.config.llm = {
      provider: 'openai',
      apiKey: key,
      model,
      endpoint: provider.endpoint,
    };
    saveConfig(ctx.config);
    ctx.agent.setModel(model);
    console.log(chalk.green(`\n  ✓ LLM saved: ${provider.label} · ${model} · ${maskApiKey(key)}\n`));
    console.log(chalk.gray('    Endpoint changes take effect on the next CLI restart.\n'));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editMcp(ctx: CommandContext): Promise<boolean> {
  try {
    const pick = await askChoice(
      'How should the CLI reach the BrainRouter MCP?',
      [
        { label: 'Local stdio', description: 'Spawn `brainrouter-mcp` on $PATH' },
        { label: 'Local HTTP', description: 'http://localhost:3747/mcp' },
        { label: 'Remote HTTP', description: 'Custom URL — pick "Other" for a different host' },
      ],
      { header: 'MCP' },
    );
    let url: string | undefined;
    if (pick === 'Local stdio') {
      ctx.config.servers['local-stdio'] = { type: 'stdio', command: 'brainrouter-mcp', args: [], identity: 'brainrouter' };
      ctx.config.activeServer = 'local-stdio';
    } else if (pick === 'Local HTTP') {
      ctx.config.servers['local-http'] = { type: 'http', url: 'http://localhost:3747/mcp', identity: 'brainrouter' };
      ctx.config.activeServer = 'local-http';
    } else {
      url = typeof pick === 'string' ? pick.trim() : '';
      if (pick === 'Remote HTTP') {
        const urlAnswer = await askChoice('Remote MCP URL:', [{ label: 'http://localhost:3747/mcp', description: 'default' }], { header: 'URL', prefilledOther: '' });
        url = typeof urlAnswer === 'string' ? urlAnswer.trim() : '';
      }
      if (!url) return false;
      ctx.config.servers['remote'] = { type: 'http', url, identity: 'brainrouter' };
      ctx.config.activeServer = 'remote';
    }
    saveConfig(ctx.config);
    console.log(chalk.green(`\n  ✓ MCP profile saved as active.\n`));
    console.log(chalk.gray('    Run /mcp reconnect to pick up the change without restarting.\n'));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editTheme(ctx: CommandContext): Promise<boolean> {
  try {
    const answer = await askChoice(
      'Which theme?',
      [
        { label: 'dark', description: 'saturated accents on black' },
        { label: 'light', description: 'darker accents for white terminals' },
        { label: 'mono', description: 'no color' },
        { label: 'auto', description: 'falls back to dark for now' },
      ],
      { header: 'Theme' },
    );
    if (typeof answer !== 'string') return false;
    writePreferences(ctx.agent.workspaceRoot, { theme: answer as Preferences['theme'] });
    console.log(chalk.green(`\n  ✓ Theme → ${answer}\n`));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editStatusline(ctx: CommandContext): Promise<boolean> {
  const current = readPreferences(ctx.agent.workspaceRoot).statusline;
  try {
    const answer = await askChoice(
      'Statusline segments (comma-separated):',
      [
        { label: 'mode', description: 'just the access mode' },
        { label: 'mode,branch,goal,model', description: 'compact dev' },
        { label: 'mode,exec,effort,branch,workflow,goal,plan,model,session', description: 'verbose' },
      ],
      { header: 'Statusline', prefilledOther: current },
    );
    const raw = typeof answer === 'string' ? answer : current;
    const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((s) => !isKnownSegment(s));
    if (unknown.length > 0) {
      console.log(chalk.red(`\n  Unknown segment(s): ${unknown.join(', ')}.  Valid: ${SEGMENT_NAMES.join(', ')}\n`));
      return false;
    }
    writePreferences(ctx.agent.workspaceRoot, { statusline: requested.join(',') });
    ctx.repl.refreshPromptForMode();
    console.log(chalk.green(`\n  ✓ Statusline → ${requested.join(',')}\n`));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editEffort(ctx: CommandContext): Promise<boolean> {
  try {
    const answer = await askChoice(
      'Reasoning effort?',
      [
        { label: 'low', description: 'terse, one-paragraph answers' },
        { label: 'medium', description: 'default · no overlay' },
        { label: 'high', description: 'step-by-step audit before each tool call' },
      ],
      { header: 'Effort' },
    );
    if (typeof answer !== 'string') return false;
    writePreferences(ctx.agent.workspaceRoot, { effort: answer as EffortLevel });
    ctx.agent.refreshSystemPrompt();
    console.log(chalk.green(`\n  ✓ Effort → ${answer}\n`));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editExecutionMode(ctx: CommandContext): Promise<boolean> {
  try {
    const answer = await askChoice(
      'Execution mode?',
      [
        { label: 'planning', description: 'default · every run_command y/N' },
        { label: 'fast', description: 'safe commands auto-run; dangerous still prompt' },
      ],
      { header: 'Mode' },
    );
    if (typeof answer !== 'string') return false;
    writePreferences(ctx.agent.workspaceRoot, { executionMode: answer as ExecutionMode });
    console.log(chalk.green(`\n  ✓ Execution mode → ${answer}\n`));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editReviewPolicy(ctx: CommandContext): Promise<boolean> {
  try {
    const answer = await askChoice(
      'Review policy?',
      [
        { label: 'request', description: 'default · prompt for /approve' },
        { label: 'proceed', description: 'apply plan and report after' },
      ],
      { header: 'Review' },
    );
    if (typeof answer !== 'string') return false;
    writePreferences(ctx.agent.workspaceRoot, { reviewPolicy: answer as ReviewPolicy });
    console.log(chalk.green(`\n  ✓ Review policy → ${answer}\n`));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editPersonality(ctx: CommandContext): Promise<boolean> {
  try {
    const answer = await askChoice(
      'Personality?',
      [
        { label: 'concise', description: 'short responses' },
        { label: 'standard', description: 'default' },
        { label: 'detailed', description: 'verbose explanations' },
        { label: 'pair-programmer', description: 'think-out-loud' },
      ],
      { header: 'Personality' },
    );
    if (typeof answer !== 'string') return false;
    writePreferences(ctx.agent.workspaceRoot, { personality: answer as Preferences['personality'] });
    ctx.agent.refreshSystemPrompt();
    console.log(chalk.green(`\n  ✓ Personality → ${answer}\n`));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

async function editEditorMode(ctx: CommandContext): Promise<boolean> {
  try {
    const answer = await askChoice(
      'Editor mode?',
      [
        { label: 'emacs', description: 'default readline' },
        { label: 'vi', description: 'vi keybindings (terminal-dependent)' },
      ],
      { header: 'Editor' },
    );
    if (typeof answer !== 'string') return false;
    writePreferences(ctx.agent.workspaceRoot, { editorMode: answer as Preferences['editorMode'] });
    console.log(chalk.green(`\n  ✓ Editor mode → ${answer}. Restart the CLI to apply.\n`));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) return false;
    throw err;
  }
}

function toggleBool(key: 'quiet'): (ctx: CommandContext) => Promise<boolean> {
  return async (ctx) => {
    const current = readPreferences(ctx.agent.workspaceRoot)[key];
    const next = !current;
    writePreferences(ctx.agent.workspaceRoot, { [key]: next } as any);
    if (key === 'quiet') {
      if (next) process.env.BRAINROUTER_QUIET = '1';
      else delete process.env.BRAINROUTER_QUIET;
    }
    console.log(chalk.green(`\n  ✓ ${key} → ${next ? 'on' : 'off'}\n`));
    return true;
  };
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
    console.log(chalk.gray(`  Known keys: ${Object.keys(KEY_HANDLERS).join(', ')}.  Run /config (bare) for an interactive panel.\n`));
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
