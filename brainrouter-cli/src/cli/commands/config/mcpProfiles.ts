// /config → MCP row: the multi-MCP profile MANAGER (list → add / edit / probe /
// remove, plus the "highlighted server" picker and transactional live pool
// connect/reconnect). Split out of the config command so the profile flows stay
// self-contained.
import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { saveConfigOrThrow, type ServerConfig } from '@kinqs/brainrouter-core/config';
import {
  McpClientWrapper,
  resolvePreferredBrainrouterServerId,
  selectMcpServerIds,
} from '@kinqs/brainrouter-core/mcp';
import { maskApiKey } from '@kinqs/brainrouter-core/provider';
import type { PickerRow } from '../../ink/prompt/runPicker.js';
import type { Theme } from '../../theme/theme.js';
import {
  pickFromList, promptText, themeFor, parseKeyValueLines, formatKeyValueLines,
} from './shared.js';
import { promptBrainrouterApiKey } from './editors.js';
import {
  isBrainrouterProfile,
  otherBrainrouterProfileIds,
  reconcileLiveMcpProfile,
  resolveEffectiveMcpProfile,
} from '../../mcpProfileLifecycle.js';
import { resolveEffectiveLlmConfig } from '../../../entry/mcpStartup.js';
import {
  editableMcpHttpUrl,
  editableMcpStdioCommand,
  isLocalMcpHttpUrl,
  normalizeMcpHttpUrl,
  redactMcpErrorText,
  redactMcpHttpUrl,
  redactMcpStdioCommand,
  validateMcpHttpUrl,
} from '../../mcpUrl.js';

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
export async function editMcp(ctx: CommandContext): Promise<boolean> {
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
        const transportLabel = s.type === 'http' ? `http · ${redactMcpHttpUrl(s.url)}` : `stdio · ${redactMcpStdioCommand(s)}`;
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
      const previousActive = ctx.config.activeServer;
      const previousActiveBrainrouter = ctx.config.activeBrainrouterServer;
      const addedId = await addMcpProfile(ctx, theme);
      if (addedId) {
        const addedBrainrouter = isBrainrouterProfile(ctx, addedId);
        const otherBrainrouterIds = addedBrainrouter
          ? otherBrainrouterProfileIds(ctx, addedId)
          : [];
        const shouldConnect = !addedBrainrouter || otherBrainrouterIds.length === 0;
        if (!ctx.config.activeServer || !ctx.config.servers[ctx.config.activeServer]) {
          ctx.config.activeServer = addedId;
        }
        if (addedBrainrouter && !ctx.config.activeBrainrouterServer && shouldConnect) {
          ctx.config.activeBrainrouterServer = addedId;
        }
        try {
          saveConfigOrThrow(ctx.config);
        } catch (err: any) {
          delete ctx.config.servers[addedId];
          ctx.config.activeServer = previousActive;
          ctx.config.activeBrainrouterServer = previousActiveBrainrouter;
          console.log(chalk.red(`\n  ✗ Could not save MCP server: ${redactMcpErrorText(String(err?.message ?? err), ctx.config)}\n`));
          continue;
        }
        console.log(chalk.green(`\n  ✓ "${addedId}" added.`));
        if (shouldConnect) {
          await tryConnectInPool(ctx, addedId);
        } else {
          console.log(chalk.gray('    → saved idle; select it as the highlighted server to switch brains'));
        }
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
      mask: true,
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
      validate: validateMcpHttpUrl,
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
        mask: true,
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
      mask: true,
    });
    if (headersRes.kind !== 'accept') return undefined;
    server = {
      type: 'http',
      url: normalizeMcpHttpUrl(urlRes.text),
      apiKey: apiKey || undefined,
      headers: parseKeyValueLines(headersRes.text),
      identity,
    };
  }
  ctx.config.servers[name] = server;
  return name;
}

/** Persist one profile edit atomically from the interactive config manager. */
function persistMcpServerUpdate(
  ctx: CommandContext,
  id: string,
  next: ServerConfig,
): boolean {
  const previous = ctx.config.servers[id];
  ctx.config.servers[id] = next;
  try {
    saveConfigOrThrow(ctx.config);
    dropRuntimeMcpServerOverlay(ctx, id);
    return true;
  } catch (err: any) {
    if (previous) ctx.config.servers[id] = previous;
    else delete ctx.config.servers[id];
    console.log(chalk.red(`  ✗ Could not save "${id}": ${redactMcpErrorText(String(err?.message ?? err), ctx.config, id)}\n`));
    return false;
  }
}

/** Durable profile edits invalidate their launch snapshot after a successful write. */
function dropRuntimeMcpServerOverlay(
  ctx: CommandContext,
  id: string,
  resetSelectors = false,
): void {
  const runtime = ctx.repl.runtimeMcp;
  if (!runtime || !Object.prototype.hasOwnProperty.call(runtime.servers, id)) return;
  const servers = { ...runtime.servers };
  delete servers[id];
  ctx.repl.runtimeMcp = {
    ...runtime,
    servers,
    activeServer: resetSelectors && runtime.activeServer === id
      ? ctx.config.activeServer
      : runtime.activeServer,
    activeBrainrouterServer: resetSelectors && runtime.activeBrainrouterServer === id
      ? ctx.config.activeBrainrouterServer
      : runtime.activeBrainrouterServer,
  };
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
      ? `http · ${redactMcpHttpUrl(server.url)}${server.apiKey ? ` · key ${maskApiKey(server.apiKey)}` : ''}${server.headers ? ` · ${Object.keys(server.headers).length} headers` : ''}`
      : `stdio · ${redactMcpStdioCommand(server)}${server.env ? ` · ${Object.keys(server.env).length} env` : ''}`;
    const result = await pickFromList({
      theme,
      title: `MCP profile · ${id}`,
      subtitle: `${summary}  ·  identity: ${server.identity ?? 'unknown'}`,
      rows: [
        ...(server.type === 'http'
          ? [{ id: 'url',     label: 'Edit URL',     value: redactMcpHttpUrl(server.url),  description: 'Change the HTTP endpoint' } as PickerRow]
          : [{ id: 'command', label: 'Edit command', value: redactMcpStdioCommand(server), description: 'Change the stdio command + args' } as PickerRow]),
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
        theme, title: 'URL', badge: 'MCP', prefilled: editableMcpHttpUrl(server.url), placeholder: 'https://...',
        validate: validateMcpHttpUrl,
      });
      if (r.kind === 'accept') {
        const normalizedUrl = normalizeMcpHttpUrl(r.text);
        if (!persistMcpServerUpdate(ctx, id, { ...server, type: 'http', url: normalizedUrl })) continue;
        // Reconnect the pool so the new URL takes effect immediately.
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ URL updated → ${redactMcpHttpUrl(normalizedUrl)}\n`));
      }
      continue;
    }
    if (result.id === 'command') {
      const editableCommand = editableMcpStdioCommand(server);
      const hidesInlineCredentials = editableCommand === '' && Boolean(server.command);
      const r = await promptText({
        theme, title: 'Command + args', badge: 'MCP',
        prefilled: editableCommand,
        placeholder: 'command [args...]',
        subtitle: hidesInlineCredentials
          ? 'Stored inline credentials are hidden. Re-enter the full command, or move secrets to environment variables.'
          : 'Prefer environment variables for credentials.',
        validate: (raw) => raw.trim() ? undefined : 'command required',
      });
      if (r.kind === 'accept') {
        const parts = r.text.trim().split(/\s+/);
        if (!persistMcpServerUpdate(ctx, id, { ...server, type: 'stdio', command: parts[0], args: parts.slice(1) })) continue;
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ Command updated.\n`));
      }
      continue;
    }
    if (result.id === 'headers' && server.type === 'http') {
      const r = await promptText({
        theme, title: 'HTTP headers', badge: 'MCP headers',
        prefilled: formatKeyValueLines(server.headers),
        mask: true,
        placeholder: 'X-Workspace=...; X-Project=...',
        subtitle: 'Optional. Header-Name=value pairs separated by semicolons. Blank clears custom headers.',
      });
      if (r.kind === 'accept') {
        const headers = parseKeyValueLines(r.text);
        if (!persistMcpServerUpdate(ctx, id, { ...server, headers })) continue;
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ Headers updated.\n`));
      }
      continue;
    }
    if (result.id === 'env' && server.type === 'stdio') {
      const r = await promptText({
        theme, title: 'Environment variables', badge: 'MCP env',
        prefilled: formatKeyValueLines(server.env),
        mask: true,
        placeholder: 'GITHUB_TOKEN=...; PROJECT_ID=...',
        subtitle: 'Optional. KEY=value pairs separated by semicolons. Blank clears custom environment variables.',
      });
      if (r.kind === 'accept') {
        const env = parseKeyValueLines(r.text);
        if (!persistMcpServerUpdate(ctx, id, { ...server, env })) continue;
        await tryReconnectInPool(ctx, id);
        console.log(chalk.green(`  ✓ Environment updated.\n`));
      }
      continue;
    }
    if (result.id === 'apikey') {
      let apiKey: string | undefined;
      if (server.identity === 'brainrouter') {
        const isLocal = server.type === 'http' && isLocalMcpHttpUrl(server.url);
        apiKey = await promptBrainrouterApiKey(theme, isLocal ? 'local' : 'remote', server.apiKey);
        if (apiKey === undefined) continue;
      } else {
        const r = await promptText({
          theme, title: 'API key', badge: 'MCP',
          prefilled: server.apiKey ?? '',
          mask: true,
          placeholder: '(blank OK)',
          subtitle: `Bearer token for "${id}". Leave blank if the server doesn't require auth.`,
        });
        if (r.kind !== 'accept') continue;
        apiKey = r.text.trim();
      }
      if (!persistMcpServerUpdate(ctx, id, { ...server, apiKey: apiKey || undefined })) continue;
      await tryReconnectInPool(ctx, id);
      console.log(chalk.green(`  ✓ API key updated.\n`));
      continue;
    }
    if (result.id === 'probe') {
      console.log(chalk.gray(`  Probing "${id}"…`));
      try {
        const toolCount = await probeMcpProfile(ctx, id);
        console.log(chalk.green(`  ✓ "${id}" reachable (${toolCount} tools).\n`));
      } catch (err: any) {
        console.log(chalk.red(`  ✗ probe failed: ${redactMcpErrorText(String(err?.message ?? err), ctx.config, id)}\n`));
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
        const previousServer = ctx.config.servers[id];
        const previousActive = ctx.config.activeServer;
        const previousActiveBrainrouter = ctx.config.activeBrainrouterServer;
        delete ctx.config.servers[id];
        if (ctx.config.activeBrainrouterServer === id) {
          ctx.config.activeBrainrouterServer = Object.keys(ctx.config.servers).find((serverId) =>
            isBrainrouterProfile(ctx, serverId),
          );
        }
        if (ctx.config.activeServer === id) {
          // Pick the next surviving profile as the new highlight, or
          // clear it if none remain.
          const remaining = Object.keys(ctx.config.servers);
          ctx.config.activeServer = remaining[0] ?? '';
        }
        try {
          saveConfigOrThrow(ctx.config);
        } catch (err: any) {
          ctx.config.servers[id] = previousServer;
          ctx.config.activeServer = previousActive;
          ctx.config.activeBrainrouterServer = previousActiveBrainrouter;
          console.log(chalk.red(`  ✗ Could not remove "${id}": ${redactMcpErrorText(String(err?.message ?? err), ctx.config, id)}\n`));
          continue;
        }
        dropRuntimeMcpServerOverlay(ctx, id, true);
        try {
          await (ctx.mcpClient as any).removeOne?.(id);
        } catch (err: any) {
          console.log(chalk.yellow(`  Profile removed from config, but the live disconnect failed: ${redactMcpErrorText(String(err?.message ?? err), ctx.config, id)}`));
        }
        console.log(chalk.yellow(`  ✓ Removed "${id}".\n`));
        return;
      }
      continue;
    }
  }
}

/**
 * Highlighted-server picker. Selecting a BrainRouter profile also reconciles
 * the running pool so it becomes the sole active brain immediately.
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
      const transport = s.type === 'http' ? `http · ${redactMcpHttpUrl(s.url)}` : `stdio · ${redactMcpStdioCommand(s)}`;
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
  const previousActive = ctx.config.activeServer;
  const previousActiveBrainrouter = ctx.config.activeBrainrouterServer;
  ctx.config.activeServer = result.id;
  if (isBrainrouterProfile(ctx, result.id)) {
    ctx.config.activeBrainrouterServer = result.id;
  }
  try {
    saveConfigOrThrow(ctx.config);
  } catch (err: any) {
    ctx.config.activeServer = previousActive;
    ctx.config.activeBrainrouterServer = previousActiveBrainrouter;
    console.log(chalk.red(`\n  ✗ Could not save highlighted server: ${redactMcpErrorText(String(err?.message ?? err), ctx.config)}\n`));
    return;
  }
  if (isBrainrouterProfile(ctx, result.id)) {
    try {
      await reconcileLiveMcpProfile(ctx, result.id, { persistActiveBrainrouter: false });
    } catch (err: any) {
      console.log(chalk.yellow(`\n  Highlight saved, but the live switch failed: ${redactMcpErrorText(String(err?.message ?? err), ctx.config, result.id)}\n`));
    }
  }
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
    const status = await reconcileLiveMcpProfile(ctx, id);
    if (status?.status === 'connected') {
      console.log(chalk.gray(`    → connected (${status.toolCount ?? 0} tools)`));
    } else if (status?.status === 'failed') {
      console.log(chalk.yellow(`    → saved but offline (${redactMcpErrorText(status.error ?? 'unknown', ctx.config, id)}). Try /mcp reconnect ${id} once the server is up.`));
    }
  } catch (err: any) {
    console.log(chalk.yellow(`    → connect attempt failed: ${redactMcpErrorText(String(err?.message ?? err), ctx.config, id)}`));
  }
}

async function tryReconnectInPool(ctx: CommandContext, id: string): Promise<void> {
  const pool: any = ctx.mcpClient;
  if (typeof pool?.reconnectOne !== 'function' || typeof pool?.connectOne !== 'function') return;
  const cfg = ctx.config.servers[id];
  if (!cfg) return;
  if (
    isBrainrouterProfile(ctx, id)
    && !selectMcpServerIds(
      ctx.config.servers,
      resolvePreferredBrainrouterServerId(
        ctx.config.servers,
        ctx.config.activeBrainrouterServer,
        ctx.config.activeServer,
      ),
    ).includes(id)
  ) {
    return;
  }
  try {
    await reconcileLiveMcpProfile(ctx, id, { forceReconnect: true });
  } catch { /* user can /mcp reconnect manually */ }
}

async function probeMcpProfile(ctx: CommandContext, id: string): Promise<number> {
  const profile = await resolveEffectiveMcpProfile(ctx, id);
  const client = new McpClientWrapper();
  const timeoutMs = 5_000;
  const deadline = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const withDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  };

  try {
    await withDeadline(client.connect(
      profile,
      resolveEffectiveLlmConfig(ctx.config, ctx.repl.launchPolicy),
      id,
    ));
    const result = await withDeadline(client.listTools());
    return Array.isArray(result.tools) ? result.tools.length : 0;
  } finally {
    try { await client.close(); } catch { /* best-effort probe cleanup */ }
  }
}
