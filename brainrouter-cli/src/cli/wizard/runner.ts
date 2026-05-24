import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import {
  askChoice,
  CancelledChoiceError,
  NoTTYError,
  setActiveReadline,
} from '../cliPrompt.js';
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
import { BOX, buildTheme, type Theme, type ThemeMode } from '../theme.js';

/**
 * 0.3.7 onboarding wizard — runs the step machine over the existing
 * `askChoice` raw-mode picker.
 *
 * Two callers:
 *
 *   1. **First-run auto-trigger** — `index.ts` chat command detects a
 *      missing `~/.config/brainrouter/config.json` and calls
 *      `runWizard({ ownsReadline: true })` BEFORE constructing the
 *      `Agent` / `McpClient`. The wizard creates its own readline,
 *      publishes it via `setActiveReadline`, walks the user through
 *      all steps, commits, and tears the readline down. The caller
 *      then loads the freshly-saved config and proceeds into the REPL.
 *   2. **`/init` slash command** — invoked from inside the REPL.
 *      The REPL already owns the readline; the wizard reuses it
 *      (`ownsReadline: false`) and never tears it down.
 *
 * Aborting at any step (`q`, `Esc` on a top-level picker, Ctrl+C)
 * leaves disk untouched. Re-running `/init` is always safe.
 *
 * Reference patterns:
 *   - `openSrc/codex/codex-rs/tui/src/onboarding/onboarding_screen.rs`
 *     for the Step enum + per-step focus.
 *   - `openSrc/DeepSeek-TUI/crates/tui/src/tui/onboarding/mod.rs:60`
 *     for the `~/.brainrouter/.onboarded` marker pattern.
 *   - `openSrc/grok-cli/src/ui/app.tsx:644` for the "first-run modal
 *     IS the onboarding" idea.
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
    // Non-fatal — the wizard still completes; subsequent CLI starts
    // just won't know we already onboarded. Better than crashing on a
    // permissions-denied write to ~/.config.
  }
}

export interface WizardRunOptions {
  /** True when the wizard must create + tear down its own readline. */
  ownsReadline: boolean;
  /** Workspace path used for preferences persistence + AGENT.md write. */
  workspaceRoot: string;
}

export interface WizardRunResult {
  state: WizardState;
  config?: Config;
}

/**
 * Drive the wizard end-to-end. Returns the terminal `WizardState` so the
 * caller can branch on `committed` (advance to the REPL) vs `aborted`
 * (exit). When committed, the loaded `Config` is returned alongside so
 * the caller doesn't have to re-read disk.
 */
export async function runWizard(opts: WizardRunOptions): Promise<WizardRunResult> {
  let rl: readline.Interface | undefined;
  if (opts.ownsReadline) {
    if (!process.stdin.isTTY) {
      // First-run auto-trigger in a non-TTY context (CI, piped) — we
      // can't pop a wizard. Surface a clear error so the user knows
      // they need to run `brainrouter` interactively at least once,
      // OR set the relevant env vars and ship a config.json.
      throw new NoTTYError(
        'BrainRouter has no config and stdin is not a TTY — run `brainrouter` in an interactive terminal at least once to complete the setup wizard.',
      );
    }
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    // The picker uses askChoice → activeReadline. Publish ours so the
    // wizard's pickers can grab it.
    setActiveReadline(rl);
    readline.emitKeypressEvents(process.stdin);
    try { (process.stdin as any).setRawMode?.(true); } catch { /* not a real TTY */ }
  }

  let state = initWizardState();
  try {
    while (!state.committed && !state.aborted) {
      state = await runStep(state, opts);
    }
  } catch (err) {
    if (opts.ownsReadline && rl) {
      setActiveReadline(undefined);
      try { rl.close(); } catch { /* ignore */ }
    }
    throw err;
  }

  let savedConfig: Config | undefined;
  if (state.committed) {
    savedConfig = commitWizardDraft(state.draft, opts.workspaceRoot);
    markOnboarded();
    renderDoneSummary(state, savedConfig);
  } else if (state.aborted) {
    process.stdout.write(chalk.yellow('\n  Wizard aborted — no changes saved.\n\n'));
  }

  if (opts.ownsReadline && rl) {
    setActiveReadline(undefined);
    try { rl.close(); } catch { /* ignore */ }
  }
  return { state, config: savedConfig };
}

/**
 * Drive a single step. Returns the new wizard state. Each step uses
 * `askChoice` for its primary UI; free-text values flow through the
 * picker's "Other" fallback so we don't need a separate readline-driven
 * input mode.
 */
async function runStep(state: WizardState, opts: WizardRunOptions): Promise<WizardState> {
  switch (state.currentStep) {
    case 'welcome':
      return runWelcomeStep(state);
    case 'theme':
      return runThemeStep(state, opts.workspaceRoot);
    case 'provider':
      return runProviderStep(state);
    case 'apiKey':
      return runApiKeyStep(state);
    case 'model':
      return runModelStep(state);
    case 'mcp':
      return runMcpStep(state);
    case 'agentMd':
      return runAgentMdStep(state, opts.workspaceRoot);
    case 'done':
      return reduceWizard(state, { kind: 'commit' });
  }
}

// --- Step renderers ----------------------------------------------------

function renderProgress(step: Step): string {
  // STEP_ORDER includes welcome + done; user-facing count uses the 6
  // decision steps in the middle so "Step 1/6" lines up with theme.
  const decisionSteps: Step[] = ['theme', 'provider', 'apiKey', 'model', 'mcp', 'agentMd'];
  const idx = decisionSteps.indexOf(step);
  if (idx < 0) return '';
  return ` (step ${idx + 1}/${decisionSteps.length})`;
}

function printBoxedCard(lines: string[], theme: Theme): void {
  const width = Math.min(
    Math.max(40, Math.max(...lines.map((l) => stripAnsi(l).length))) + 4,
    Math.max(40, (process.stdout.columns ?? 80) - 4),
  );
  const top = BOX.topLeft + BOX.horizontal.repeat(width - 2) + BOX.topRight;
  const bottom = BOX.bottomLeft + BOX.horizontal.repeat(width - 2) + BOX.bottomRight;
  process.stdout.write('\n' + theme.primary(top) + '\n');
  for (const line of lines) {
    const visible = stripAnsi(line);
    const pad = Math.max(0, width - 4 - visible.length);
    process.stdout.write(
      theme.primary(BOX.vertical) + ' ' + line + ' '.repeat(pad) + ' ' + theme.primary(BOX.vertical) + '\n',
    );
  }
  process.stdout.write(theme.primary(bottom) + '\n\n');
}

function stripAnsi(s: string): string {
  // Minimal ANSI stripper — wide enough for chalk's SGR sequences.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

async function runWelcomeStep(state: WizardState): Promise<WizardState> {
  const theme = buildTheme('dark');
  printBoxedCard(
    [
      theme.heading('🧠  Welcome to BrainRouter'),
      '',
      theme.muted('A memory-native coding agent that runs in your terminal.'),
      theme.muted('This wizard takes ~60 seconds and writes:'),
      '',
      '  ' + theme.info('~/.config/brainrouter/config.json') + theme.muted('   (LLM + MCP)'),
      '  ' + theme.info('<workspace>/.brainrouter/cli/preferences.json') + theme.muted(' (UI prefs)'),
      '',
      theme.muted('Press ENTER to start.  Press q at any picker to abort.'),
    ],
    theme,
  );
  try {
    const answer = await askChoice(
      'Start the setup wizard?',
      [
        { label: 'Start setup', description: 'Theme → Provider → API key → Model → MCP' },
        { label: 'Abort', description: 'Exit without saving anything' },
      ],
      { header: 'Welcome' },
    );
    if (answer === 'Abort') return reduceWizard(state, { kind: 'abort' });
    return reduceWizard(state, { kind: 'advance', patch: {} });
  } catch (err) {
    if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
    throw err;
  }
}

async function runThemeStep(state: WizardState, workspaceRoot: string): Promise<WizardState> {
  const themes: { label: string; description: string; mode: ThemeMode }[] = [
    { label: 'dark', description: 'default · saturated accents on a black terminal', mode: 'dark' },
    { label: 'light', description: 'darker accents for white terminals (solarized-light, GitHub light)', mode: 'light' },
    { label: 'mono', description: 'no color · screenshots, CI logs, pipe-to-less', mode: 'mono' },
  ];
  process.stdout.write(chalk.bold(`\nTheme${renderProgress('theme')}\n`));
  process.stdout.write(chalk.gray('  Pick a color palette. Arrow keys live-preview the accent.\n\n'));
  try {
    const answer = await askChoice(
      'Which theme should the CLI use?',
      themes.map(({ label, description }) => ({ label, description })),
      {
        header: 'Theme',
        onCursorChange: (cursor) => {
          // Live preview — repaint the prompt accent in the picked
          // theme's primary so the user sees the change before
          // confirming. The picker re-renders its own box every
          // keystroke, so we only need to write a single sample.
          const mode = themes[cursor]?.mode ?? 'dark';
          const preview = buildTheme(mode);
          process.stdout.write(
            '\n  ' + preview.primary('brainrouter[preview]>') + ' ' + preview.muted('sample prompt') + '\n',
          );
        },
      },
    );
    const picked = themes.find((t) => t.label === answer);
    const mode: ThemeMode = picked ? picked.mode : 'dark';
    // Persist immediately so subsequent steps' prompts respect the
    // pick. The other prefs land at the Done step's commit pass.
    try { writePreferences(workspaceRoot, { theme: mode }); } catch { /* non-fatal */ }
    return reduceWizard(state, { kind: 'advance', patch: { theme: mode } });
  } catch (err) {
    if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
    throw err;
  }
}

async function runProviderStep(state: WizardState): Promise<WizardState> {
  const detected = detectProviderFromEnv();
  process.stdout.write(chalk.bold(`\nLLM provider${renderProgress('provider')}\n`));
  if (detected) {
    process.stdout.write(chalk.gray(`  Detected ${detected.envKey} in your shell — ${detected.label} is pre-selected.\n\n`));
  } else {
    process.stdout.write(chalk.gray('  Pick the LLM provider for the chat agent.\n\n'));
  }
  const rows = PROVIDER_CATALOG.map((p) => {
    const envHit = !!process.env[p.envKey];
    const tag = envHit ? '(env key detected)' : p.local ? '(local · key optional)' : '(needs API key)';
    return { label: p.label, description: `${p.hint}  ${chalk.gray(tag)}` };
  });
  // The "Other" synthetic row already covers custom endpoints — the
  // user can drop into the free-text mode and paste any OpenAI-compat
  // URL. So we don't add a "Custom…" row here.
  const initialCursor = detected ? PROVIDER_CATALOG.findIndex((p) => p.id === detected.id) : 0;
  try {
    const answer = await askChoice(
      'Which LLM provider?',
      rows,
      { header: 'Provider', initialCursor: Math.max(0, initialCursor) },
    );
    const known = PROVIDER_CATALOG.find((p) => p.label === answer);
    if (known) {
      return reduceWizard(state, { kind: 'advance', patch: { provider: known } });
    }
    // The user typed a custom endpoint via the "Other" row. Synthesize
    // a provider entry on the fly — they own the endpoint + their own
    // model list.
    const customUrl = typeof answer === 'string' ? answer.trim() : '';
    if (!customUrl) {
      // Unexpected — askChoice should have rejected empty Other. Defer
      // to the user by re-asking instead of pushing a half-baked draft.
      return state;
    }
    const ad: ProviderEntry = {
      id: 'custom',
      label: 'Custom endpoint',
      hint: customUrl,
      endpoint: customUrl,
      envKey: 'BRAINROUTER_LLM_API_KEY',
      local: /localhost|127\.0\.0\.1|::1|0\.0\.0\.0/.test(customUrl),
      models: [],
      defaultModel: 'gpt-4o-mini',
    };
    return reduceWizard(state, {
      kind: 'advance',
      patch: { provider: ad, customEndpoint: customUrl },
    });
  } catch (err) {
    if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
    throw err;
  }
}

async function runApiKeyStep(state: WizardState): Promise<WizardState> {
  const provider = state.draft.provider;
  if (!provider) return reduceWizard(state, { kind: 'back' });
  process.stdout.write(chalk.bold(`\nAPI key${renderProgress('apiKey')}\n`));
  const envValue = process.env[provider.envKey] ?? '';
  if (envValue) {
    process.stdout.write(chalk.gray(`  ${provider.envKey} is set in your shell — press ENTER to accept, or type a different key.\n`));
  } else if (provider.local) {
    process.stdout.write(chalk.gray(`  ${provider.label} is local — a blank API key is fine.\n`));
  } else {
    process.stdout.write(chalk.gray(`  Paste your ${provider.label} API key. Stored at ~/.config/brainrouter/config.json.\n`));
  }
  process.stdout.write('\n');
  try {
    // Drop the picker straight into Other / free-text mode with the
    // env value pre-loaded. ENTER accepts, edit overrides.
    const answer = await askChoice(
      `${provider.label} API key:`,
      [
        { label: 'Skip (local endpoint, no key)', description: 'Use a blank key — only safe for LM Studio / Ollama / custom local' },
      ],
      { header: 'API key', prefilledOther: envValue },
    );
    let raw = typeof answer === 'string' ? answer : Array.isArray(answer) ? answer.join('') : '';
    if (raw === 'Skip (local endpoint, no key)') raw = '';
    const verdict = validateApiKey(raw, provider);
    if (verdict.kind === 'reject') {
      process.stdout.write(chalk.red(`  ✗  ${verdict.reason}\n  Press ENTER to retry.\n`));
      // Re-ask by leaving state on the same step.
      return state;
    }
    let nextState = state;
    if (verdict.kind === 'accept' && verdict.warning) {
      nextState = reduceWizard(nextState, { kind: 'warn', message: verdict.warning });
    }
    process.stdout.write(chalk.green(`  ✓  Saved as ${maskApiKey(raw)}.\n`));
    return reduceWizard(nextState, { kind: 'advance', patch: { apiKey: raw } });
  } catch (err) {
    if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
    throw err;
  }
}

async function runModelStep(state: WizardState): Promise<WizardState> {
  const provider = state.draft.provider;
  if (!provider) return reduceWizard(state, { kind: 'back' });
  process.stdout.write(chalk.bold(`\nModel${renderProgress('model')}\n`));
  process.stdout.write(chalk.gray(`  Pick the chat model. Use "Other" for anything outside the short list.\n\n`));
  const rows = provider.models.length > 0
    ? provider.models.map((m) => ({ label: m, description: m === provider.defaultModel ? '(default)' : '' }))
    : [{ label: provider.defaultModel, description: '(default)' }];
  const initialCursor = Math.max(0, provider.models.indexOf(provider.defaultModel));
  try {
    const answer = await askChoice(
      `Which ${provider.label} model?`,
      rows,
      { header: 'Model', initialCursor },
    );
    const model = typeof answer === 'string' ? answer.trim() : provider.defaultModel;
    return reduceWizard(state, { kind: 'advance', patch: { model: model || provider.defaultModel } });
  } catch (err) {
    if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
    throw err;
  }
}

async function runMcpStep(state: WizardState): Promise<WizardState> {
  process.stdout.write(chalk.bold(`\nMCP server${renderProgress('mcp')}\n`));
  process.stdout.write(chalk.gray('  BrainRouter\'s memory + skills live behind an MCP server. Pick how to talk to it.\n\n'));
  type Row = { label: string; description: string; pick: McpPick };
  const rows: Row[] = [
    { label: 'Local stdio',  description: 'Spawn `brainrouter-mcp` on $PATH for this CLI process', pick: { kind: 'local-stdio' } },
    { label: 'Local HTTP',   description: 'Connect to http://localhost:3747/mcp (`brainrouter-mcp start:http`)', pick: { kind: 'local-http' } },
    { label: 'Remote HTTP',  description: 'Connect to a hosted BrainRouter URL (key optional)', pick: { kind: 'remote-http', url: '' } },
    { label: 'Skip',         description: 'No MCP — local tools only (no recall, skills, capture)', pick: { kind: 'skip' } },
  ];
  try {
    const answer = await askChoice(
      'How should the CLI reach the BrainRouter MCP?',
      rows.map(({ label, description }) => ({ label, description })),
      { header: 'MCP', initialCursor: 0 },
    );
    let picked = rows.find((r) => r.label === answer)?.pick;
    if (!picked) {
      // Other → treat the typed value as a remote URL.
      const url = typeof answer === 'string' ? answer.trim() : '';
      if (!url) return state;
      picked = { kind: 'remote-http', url };
    }
    if (picked.kind === 'remote-http' && !picked.url) {
      // Sub-prompt for the URL.
      try {
        const url = await askChoice(
          'Remote BrainRouter MCP URL:',
          [{ label: 'http://localhost:3747/mcp', description: 'Default — local HTTP server' }],
          { header: 'Remote URL', prefilledOther: '' },
        );
        const trimmed = typeof url === 'string' ? url.trim() : '';
        if (!trimmed) return state;
        picked = { kind: 'remote-http', url: trimmed };
      } catch (err) {
        if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
        throw err;
      }
    }
    // Optional probe.
    const probe = await probeMcp(picked, state.draft);
    if (probe.warning) {
      // Surface the warning but don't block — peer CLIs all accept
      // "save anyway" when probe fails (offline workflow, captive
      // portals, slow CI). Add it to the wizard's warning list.
      const next = reduceWizard(state, { kind: 'warn', message: probe.warning });
      return reduceWizard(next, { kind: 'advance', patch: { mcp: picked } });
    }
    return reduceWizard(state, { kind: 'advance', patch: { mcp: picked } });
  } catch (err) {
    if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
    throw err;
  }
}

async function probeMcp(pick: McpPick, draft: WizardDraft): Promise<{ ok: boolean; warning?: string }> {
  if (pick.kind === 'skip') return { ok: true };
  const wrapper = new McpClientWrapper();
  const llmConfig = draft.provider && draft.model
    ? { provider: 'openai' as const, apiKey: draft.apiKey ?? '', model: draft.model, endpoint: draft.customEndpoint ?? draft.provider.endpoint }
    : undefined;
  const serverConfig = mcpPickToServerConfig(pick);
  if (!serverConfig) return { ok: false, warning: 'Could not build MCP server config for this pick.' };
  const start = Date.now();
  try {
    await Promise.race([
      wrapper.connect(serverConfig, llmConfig, 'wizard'),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('probe timed out after 5s')), 5_000)),
    ]);
    await wrapper.close();
    const elapsed = Date.now() - start;
    process.stdout.write(chalk.green(`  ✓  MCP reachable (${elapsed}ms).\n`));
    return { ok: true };
  } catch (err: any) {
    try { await wrapper.close(); } catch { /* ignore */ }
    return {
      ok: false,
      warning: `MCP probe failed (${err?.message ?? err}). Profile saved — start the server and run \`/mcp reconnect\` later.`,
    };
  }
}

function mcpPickToServerConfig(pick: McpPick) {
  if (pick.kind === 'local-stdio') {
    return {
      type: 'stdio' as const,
      command: 'brainrouter-mcp',
      args: [],
      identity: 'brainrouter' as const,
    };
  }
  if (pick.kind === 'local-http') {
    return { type: 'http' as const, url: 'http://localhost:3747/mcp', identity: 'brainrouter' as const };
  }
  if (pick.kind === 'remote-http') {
    return { type: 'http' as const, url: pick.url, apiKey: pick.apiKey, identity: 'brainrouter' as const };
  }
  return undefined;
}

async function runAgentMdStep(state: WizardState, workspaceRoot: string): Promise<WizardState> {
  const agentMdPath = path.join(workspaceRoot, 'AGENT.md');
  const claudeMdPath = path.join(workspaceRoot, 'CLAUDE.md');
  const exists = fs.existsSync(agentMdPath) || fs.existsSync(claudeMdPath);
  process.stdout.write(chalk.bold(`\nAGENT.md${renderProgress('agentMd')}\n`));
  if (exists) {
    process.stdout.write(chalk.gray('  Workspace already has AGENT.md / CLAUDE.md — skipping by default.\n\n'));
  } else {
    process.stdout.write(chalk.gray('  AGENT.md gives every agent (Claude Code, Codex, BrainRouter, …) a single hub of repo conventions.\n\n'));
  }
  try {
    const answer = await askChoice(
      'Scaffold AGENT.md in this workspace?',
      [
        { label: exists ? 'No (already present)' : 'Yes — write AGENT.md', description: exists ? 'Keep the existing file' : 'Drops a starter template in the workspace root' },
        { label: exists ? 'Overwrite anyway' : 'No', description: exists ? 'Replace the existing AGENT.md with the starter template' : 'Skip — write it manually later' },
      ],
      { header: 'AGENT.md', initialCursor: exists ? 0 : 0 },
    );
    const writeIt = !exists && typeof answer === 'string' && answer.startsWith('Yes')
      || exists && answer === 'Overwrite anyway';
    return reduceWizard(state, { kind: 'advance', patch: { writeAgentMd: writeIt } });
  } catch (err) {
    if (err instanceof CancelledChoiceError) return reduceWizard(state, { kind: 'abort' });
    throw err;
  }
}

// --- Commit + summary --------------------------------------------------

function commitWizardDraft(draft: WizardDraft, workspaceRoot: string): Config {
  const config = loadOrInitConfig();
  // LLM
  if (draft.provider) {
    config.llm = {
      provider: 'openai',
      apiKey: draft.apiKey ?? '',
      model: draft.model ?? draft.provider.defaultModel,
      endpoint: draft.customEndpoint ?? draft.provider.endpoint,
    };
  }
  // MCP profile
  if (draft.mcp && draft.mcp.kind !== 'skip') {
    const profileName = draft.mcp.kind === 'remote-http' ? 'remote' : draft.mcp.kind === 'local-http' ? 'local-http' : 'local-stdio';
    const serverConfig = mcpPickToServerConfig(draft.mcp);
    if (serverConfig) {
      config.servers[profileName] = serverConfig;
      config.activeServer = profileName;
    }
  } else if (draft.mcp?.kind === 'skip' && !config.activeServer) {
    // No MCP picked and no prior config — leave activeServer empty so
    // the chat command surfaces the no-MCP banner cleanly.
    config.activeServer = '';
  }
  saveConfig(config);

  // Preferences
  if (draft.theme) {
    try { writePreferences(workspaceRoot, { theme: draft.theme }); } catch { /* non-fatal */ }
  }

  // AGENT.md
  if (draft.writeAgentMd) {
    try { initAgentMd(workspaceRoot); } catch { /* non-fatal — file may be read-only */ }
  }

  return config;
}

function renderDoneSummary(state: WizardState, config: Config): void {
  const theme = buildTheme(state.draft.theme ?? 'dark');
  const lines: string[] = [
    theme.heading('✓  Setup complete'),
    '',
    `  ${theme.muted('theme')}    ${state.draft.theme ?? 'dark'}`,
    `  ${theme.muted('provider')} ${state.draft.provider?.label ?? '(unset)'}`,
    `  ${theme.muted('model')}    ${state.draft.model ?? '(unset)'}`,
    `  ${theme.muted('api key')}  ${maskApiKey(state.draft.apiKey ?? '')}`,
    `  ${theme.muted('mcp')}      ${formatMcpForSummary(state.draft.mcp)}`,
    `  ${theme.muted('agent.md')} ${state.draft.writeAgentMd ? 'written' : 'skipped'}`,
    '',
    theme.muted('Config saved to ~/.config/brainrouter/config.json.'),
    theme.muted('Re-run this wizard any time with /init. Tweak individual knobs with /config.'),
  ];
  if (state.warnings.length > 0) {
    lines.push('');
    lines.push(theme.warning('Advisories:'));
    for (const w of state.warnings) {
      lines.push(`  ${theme.warning('!')} ${w.message}`);
    }
  }
  printBoxedCard(lines, theme);
}

function formatMcpForSummary(pick?: McpPick): string {
  if (!pick) return '(unset)';
  if (pick.kind === 'local-stdio') return 'local stdio (brainrouter-mcp)';
  if (pick.kind === 'local-http') return 'local http (http://localhost:3747/mcp)';
  if (pick.kind === 'remote-http') return `remote · ${pick.url}`;
  return 'skipped (offline-only)';
}
