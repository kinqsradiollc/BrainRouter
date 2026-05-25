import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { getConfigPath, saveConfig, type ServerConfig } from '../../config/config.js';
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

// Exported so `/login` can re-enter the LLM editor as a follow-on step
// after the MCP transport block. Same flow as the `/config` panel's
// "LLM" row — provider picker → API key prompt → model picker → save.
export async function editLlm(ctx: CommandContext): Promise<boolean> {
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

/**
 * `/config` → MCP row. 0.3.7 multi-MCP redesign — now a profile
 * MANAGER instead of a single-transport picker.
 *
 * Top-level panel lists every entry in `config.servers` (each
 * connects concurrently on boot via the pool) plus rows for adding
 * a new profile, choosing which one is highlighted in the banner,
 * and exiting. Picking an existing profile opens a sub-panel
 * (edit URL/command, update API key, probe, remove). Adding a new
 * profile runs a 4-step flow (name → transport → fields → API key)
 * and auto-connects via the running pool when possible — no CLI
 * restart needed.
 *
 * Pattern lifted from Claude Code's `/mcp` interactive menu (see
 * `openSrc/claude-code/CHANGELOG.md` line 2525): one screen lists all
 * servers, each row drills into per-server actions.
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
            ? 'highlighted in banner; every server in this list is connected on boot'
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
      subtitle: `${profileIds.length} configured · all connect concurrently on boot. ★ = highlighted in the banner.`,
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
    subtitle: 'Short identifier. Used in tool prefixes: mcp__<name>__<tool>.',
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
    server = { type: 'stdio', command: parts[0], args: parts.slice(1), identity };
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
    server = {
      type: 'http',
      url: urlRes.text.trim(),
      apiKey: apiKey || undefined,
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
      ? `http · ${server.url ?? ''}${server.apiKey ? ` · key ${maskApiKey(server.apiKey)}` : ''}`
      : `stdio · ${server.command ?? ''} ${(server.args ?? []).join(' ')}`;
    const result = await pickFromList({
      theme,
      title: `MCP profile · ${id}`,
      subtitle: `${summary}  ·  identity: ${server.identity ?? 'unknown'}`,
      rows: [
        ...(server.type === 'http'
          ? [{ id: 'url',     label: 'Edit URL',     value: server.url ?? '',  description: 'Change the HTTP endpoint' } as PickerRow]
          : [{ id: 'command', label: 'Edit command', value: `${server.command ?? ''} ${(server.args ?? []).join(' ')}`.trim(), description: 'Change the stdio command + args' } as PickerRow]),
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
  for (const s of Object.values(scrubbed.servers ?? {})) {
    const srv = s as any;
    if (srv.apiKey) srv.apiKey = maskApiKey(srv.apiKey);
    if (srv.env?.BRAINROUTER_API_KEY) srv.env.BRAINROUTER_API_KEY = maskApiKey(srv.env.BRAINROUTER_API_KEY);
  }
}

type SetResult = { ok: true; message: string } | { ok: false; reason: string };

interface ConfigKeyHandler {
  get: (ctx: CommandContext) => string;
  set?: (ctx: CommandContext, value: string) => SetResult | Promise<SetResult>;
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
    // Async so we can re-prompt for the API key when the provider
    // changes. Pre-0.3.7 this setter silently reused the OLD provider's
    // apiKey, which left users with (e.g.) OpenAI keys pointed at the
    // DeepSeek endpoint — 401 on every turn with no clear message.
    set: async (ctx, value) => {
      const provider = findProvider(value.trim().toLowerCase());
      if (!provider) return { ok: false, reason: `unknown provider id "${value}" — open /config (bare) and pick interactively` };
      const previousProviderId = (ctx.config.llm?.endpoint
        ? PROVIDER_CATALOG.find((p) => p.endpoint === ctx.config.llm!.endpoint)?.id
        : undefined);
      const sameProvider = previousProviderId === provider.id;

      // Reusing the existing key is correct when the provider isn't
      // actually changing (idempotent set). Re-prompt on any real
      // provider change — pre-fill from the new provider's envKey or
      // (last resort) the previously-stored key if the user wants to
      // paste a same-vendor variant.
      let apiKey = ctx.config.llm?.apiKey ?? '';
      if (!sameProvider) {
        const theme = themeFor(ctx);
        const envValue = process.env[provider.envKey] ?? '';
        const keyResult = await promptText({
          theme,
          title: `API key for ${provider.label}`,
          subtitle: envValue
            ? `${provider.envKey} is set — press ENTER to accept, type to override.`
            : provider.local
              ? `${provider.label} is local — blank key OK.`
              : `${provider.label} requires an API key. Paste it now or press Esc to cancel.`,
          badge: provider.label,
          prefilled: envValue,
          placeholder: provider.local ? '(blank OK)' : 'paste API key',
          validate: (raw) => {
            const v = validateApiKey(raw, provider);
            return v.kind === 'reject' ? v.reason : undefined;
          },
        });
        if (keyResult.kind !== 'accept') {
          return { ok: false, reason: 'cancelled — provider unchanged' };
        }
        apiKey = keyResult.text;
      }

      ctx.config.llm = {
        provider: 'openai',
        apiKey,
        model: provider.defaultModel,
        endpoint: provider.endpoint,
      };
      saveConfig(ctx.config);
      ctx.agent.setModel(provider.defaultModel);
      const tail = sameProvider
        ? '(provider unchanged — reused existing key + reset model to default)'
        : `(model defaulted to ${provider.defaultModel} · key ${maskApiKey(apiKey)})`;
      return { ok: true, message: `provider → ${provider.label} ${tail}` };
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
  const result = await handler.set(ctx, value);
  if (!result.ok) {
    console.log(chalk.red(`\n  ✗ ${result.reason}\n`));
    return;
  }
  console.log(chalk.green(`\n  ✓ ${result.message}\n`));
}
