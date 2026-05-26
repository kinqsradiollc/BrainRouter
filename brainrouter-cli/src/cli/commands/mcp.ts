/**
 * `/mcp` slash-command surface. 0.3.7 multi-MCP rewrite — third-party
 * MCPs connect concurrently while BrainRouter MCP profiles are mutually
 * exclusive so exactly one brain is active at a time.
 *
 *   /mcp                    — alias for /mcp list
 *   /mcp list               — every configured profile + per-server status
 *   /mcp tools [server]     — MCP tools grouped by `mcp_<server>_*`
 *                             namespace; pass a server id to scope
 *   /mcp connect <name>     — connect a configured server that's idle/offline
 *   /mcp disconnect <name>  — close one server's transport (config preserved)
 *   /mcp reconnect [name]   — reconnect ONE (when name given) or the selected pool
 *
 * Backwards-compat: `/mcp reconnect` with no arg reconnects the same
 * selected set used at boot: all third-party MCPs plus the active
 * BrainRouter MCP. Pass an explicit name to target one.
 */

import chalk from 'chalk';
import { spinner as makeSpinner } from '../spinner.js';
import type { CommandContext } from './_context.js';
import { saveConfig } from '../../config/config.js';
import { resolveIdentityFromConfig } from '../../runtime/mcpClient.js';
import { selectMcpServerIds } from '../../runtime/mcpPool.js';
import { buildBannerInputs, renderBanner } from '../banner.js';
import { resolveTheme } from '../theme.js';
import { runMcpInstall } from './mcpInstall.js';

export async function tryHandleMcpCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, mcpClient, config } = ctx;
  if (command !== '/mcp') return false;

  const sub = (args[0] ?? 'list').toLowerCase();
  const targetName = args[1]?.trim();

  if (sub === 'tools') {
    const onlyServer = targetName;
    console.log(chalk.bold('\nMCP tools (pooled)'));
    const statuses = mcpClient.getStatuses();
    const connected = statuses.filter((s) => s.status === 'connected');
    if (connected.length === 0) {
      console.log(chalk.yellow('  No MCP servers connected. Try /mcp reconnect.\n'));
      return true;
    }
    const spinner = makeSpinner(chalk.gray('Fetching pooled tool surface...')).start();
    try {
      const res = await mcpClient.listTools();
      const allTools = res.tools || [];
      spinner.succeed(chalk.green(`${allTools.length} tools across ${connected.length} server${connected.length === 1 ? '' : 's'}`));
      // Pool tools are exposed as `mcp_<serverId>_<rawTool>`. Group by serverId.
      const knownIds = new Set(connected.map((s) => s.serverId));
      const byServer: Record<string, string[]> = {};
      for (const t of allTools) {
        let serverId = '__unknown__';
        let raw = t.name;
        if (t.name.startsWith('mcp_')) {
          const rest = t.name.slice('mcp_'.length);
          // Server ids may contain underscores; match the longest known id.
          const id = [...knownIds].sort((a, b) => b.length - a.length).find((k) => rest.startsWith(`${k}_`));
          if (id) {
            serverId = id;
            raw = rest.slice(id.length + 1);
          } else {
            const idx = rest.indexOf('_');
            if (idx > 0) { serverId = rest.slice(0, idx); raw = rest.slice(idx + 1); }
          }
        }
        if (onlyServer && serverId !== onlyServer) continue;
        (byServer[serverId] ||= []).push(raw);
      }
      const serverIds = Object.keys(byServer).sort();
      if (serverIds.length === 0) {
        console.log(chalk.gray(`\n  No tools for server "${onlyServer}".\n`));
        return true;
      }
      for (const section of groupServerIdsByEcosystem(serverIds, (id) => mcpClient.getStatus(id)?.identity ?? 'unknown')) {
        console.log(`\n${section.title}`);
        for (const id of section.ids) {
          const ident = mcpClient.getStatus(id)?.identity ?? 'unknown';
          const identTag = formatIdentityTag(ident);
          console.log(`  ${chalk.bold.green(id)} ${identTag} (${byServer[id].length})`);
          for (const name of byServer[id].sort()) {
            console.log(`    ${chalk.gray('•')} ${name}  ${chalk.gray(`mcp_${id}_${name}`)}`);
          }
        }
      }
    } catch (err: any) {
      spinner.fail(chalk.red(`Failed: ${err.message}`));
    }
    console.log();
    return true;
  }

  if (sub === 'list') {
    const profiles = Object.keys(config.servers ?? {});
    if (profiles.length === 0) {
      console.log(chalk.yellow('\nNo MCP profiles configured. Run `/login` or `brainrouter config` to set one up.\n'));
      return true;
    }
    console.log(chalk.bold('\nMCP servers'));
    const statuses = mcpClient.getStatuses();
    const statusById = new Map(statuses.map((s) => [s.serverId, s]));
    const activeName = config.activeServer;
    for (const section of groupServerIdsByEcosystem(profiles, (name) => {
      const profile = config.servers[name];
      return statusById.get(name)?.identity ?? profile?.identity ?? 'unknown';
    })) {
      console.log(`\n${section.title}`);
      for (const name of section.ids) {
        const profile = config.servers[name];
        const poolStatus = statusById.get(name);
        // Identity: pool live > config metadata > 'unknown'.
        const identity: string = poolStatus?.identity ?? profile.identity ?? 'unknown';
        // Status: pool live > 'not in pool' (configured but never tried).
        const liveStatus = poolStatus?.status;
        const statusLabel =
          liveStatus === 'connected' ? chalk.green('online') :
          liveStatus === 'failed' ? chalk.red('failed') :
          liveStatus === 'connecting' ? chalk.yellow('connecting') :
          liveStatus === 'offline' ? chalk.gray('disconnected') :
          chalk.gray('idle');
        const idLabel = formatIdentityTag(identity);
        const marker = name === activeName ? chalk.bold('★ ') : '  ';
        const transport = profile.type;
        const target = profile.type === 'http' ? profile.url ?? '<no url>' : profile.command ?? '<no command>';
        const toolTag = poolStatus?.toolCount != null ? chalk.gray(`${poolStatus.toolCount} tools`) : '';
        const errTag = liveStatus === 'failed' && poolStatus?.error ? chalk.red(` · ${poolStatus.error}`) : '';
        console.log(`${marker}${chalk.bold(name)}  ${idLabel}  ${transport}  ${statusLabel}  ${chalk.gray(target)}  ${toolTag}${errTag}`);
      }
    }
    console.log(chalk.gray('\n★ = highlighted profile in the banner.'));
    console.log(chalk.gray('  Multi-MCP: third-party MCPs connect together; only one BrainRouter MCP is active. Use /mcp connect|disconnect|reconnect <name> to manage.\n'));
    return true;
  }

  if (sub === 'reconnect') {
    if (!targetName) {
      // No name → reconnect every configured server in the pool.
      const ids = selectMcpServerIds(config.servers ?? {}, config.activeServer);
      if (ids.length === 0) {
        console.log(chalk.red(`\nNo MCP profiles configured.\n`));
        return true;
      }
      console.log(chalk.gray(`Reconnecting all servers (${ids.length})…`));
      await Promise.allSettled(ids.map(async (id) => {
        try {
          await mcpClient.reconnectOne(id);
          const s = mcpClient.getStatus(id);
          if (s?.status === 'connected') {
            console.log(chalk.green(`  ✓ ${id}`));
          } else {
            console.log(chalk.red(`  ✗ ${id} — ${s?.error ?? 'failed'}`));
          }
        } catch (err: any) {
          console.log(chalk.red(`  ✗ ${id} — ${err?.message ?? err}`));
        }
      }));
      console.log();
      return true;
    }
    if (!config.servers?.[targetName]) {
      console.log(chalk.red(`\nNo profile named "${targetName}".\n`));
      return true;
    }
    console.log(chalk.gray(`Reconnecting "${targetName}"…`));
    try {
      await disconnectOtherBrainrouterServers(ctx, targetName);
      await mcpClient.reconnectOne(targetName);
      const s = mcpClient.getStatus(targetName);
      if (s?.status === 'connected') {
        const activated = activateBrainrouterProfile(ctx, targetName);
        console.log(chalk.green(`✓ Reconnected to "${targetName}".\n`));
        if (activated) {
          console.log(chalk.gray(`  Active BrainRouter profile saved as "${targetName}" for this and future sessions.\n`));
          printRefreshedBanner(ctx);
        }
      } else {
        console.log(chalk.red(`✗ "${targetName}" remained ${s?.status ?? 'offline'} — ${s?.error ?? 'unknown'}\n`));
      }
    } catch (err: any) {
      console.log(chalk.red(`✗ Reconnect failed: ${err?.message ?? err}\n`));
    }
    return true;
  }

  if (sub === 'connect') {
    if (!targetName) {
      console.log(chalk.red('\nUsage: /mcp connect <name>\n'));
      return true;
    }
    const profile = config.servers?.[targetName];
    if (!profile) {
      console.log(chalk.red(`\nNo profile named "${targetName}". Available: ${Object.keys(config.servers ?? {}).join(', ') || '(none)'}.\n`));
      return true;
    }
    console.log(chalk.gray(`Connecting "${targetName}"…`));
    try {
      await disconnectOtherBrainrouterServers(ctx, targetName);
      await mcpClient.connectOne(targetName, profile, config.llm, 5_000);
      const s = mcpClient.getStatus(targetName);
      if (s?.status === 'connected') {
        const activated = activateBrainrouterProfile(ctx, targetName);
        console.log(chalk.green(`✓ "${targetName}" online (${s.toolCount ?? 0} tools).\n`));
        if (activated) {
          console.log(chalk.gray(`  Active BrainRouter profile saved as "${targetName}" for this and future sessions.\n`));
          printRefreshedBanner(ctx);
        }
      } else {
        console.log(chalk.red(`✗ "${targetName}" failed — ${s?.error ?? 'unknown'}\n`));
      }
    } catch (err: any) {
      console.log(chalk.red(`✗ Connect failed: ${err?.message ?? err}\n`));
    }
    return true;
  }

  if (sub === 'install') {
    const result = runMcpInstall(args.slice(1), config);
    console.log(result.output);
    return true;
  }

  if (sub === 'disconnect') {
    if (!targetName) {
      console.log(chalk.red('\nUsage: /mcp disconnect <name>\n'));
      return true;
    }
    if (!mcpClient.getStatus(targetName)) {
      console.log(chalk.yellow(`\n"${targetName}" is not in the pool.\n`));
      return true;
    }
    try {
      await mcpClient.disconnectOne(targetName);
      console.log(chalk.green(`✓ "${targetName}" disconnected. Config preserved — /mcp connect ${targetName} to bring it back.\n`));
    } catch (err: any) {
      console.log(chalk.red(`✗ Disconnect failed: ${err?.message ?? err}\n`));
    }
    return true;
  }

  console.log(chalk.red(`\nUnknown /mcp subcommand "${sub}". Usage: /mcp list | /mcp tools [server] | /mcp connect <name> | /mcp disconnect <name> | /mcp reconnect [name] | /mcp install <vendor>|list\n`));
  return true;
}

type McpIdentity = 'brainrouter' | 'third-party' | 'unknown' | string;

function formatIdentityTag(identity: McpIdentity): string {
  return identity === 'brainrouter' ? chalk.cyan('brainrouter') :
    identity === 'third-party' ? chalk.yellow('third-party') :
    chalk.gray('unknown');
}

function groupServerIdsByEcosystem(
  ids: string[],
  identityFor: (id: string) => McpIdentity,
): Array<{ title: string; ids: string[] }> {
  const brainrouter: string[] = [];
  const other: string[] = [];
  for (const id of ids.slice().sort()) {
    if (identityFor(id) === 'brainrouter') brainrouter.push(id);
    else other.push(id);
  }
  const sections: Array<{ title: string; ids: string[] }> = [];
  if (brainrouter.length > 0) {
    sections.push({ title: chalk.bold.cyan('BrainRouter MCP (Our Ecosystem)'), ids: brainrouter });
  }
  if (other.length > 0) {
    sections.push({ title: chalk.bold.yellow('Third-party MCPs (Other)'), ids: other });
  }
  return sections;
}

async function disconnectOtherBrainrouterServers(ctx: CommandContext, targetName: string): Promise<void> {
  const targetProfile = ctx.config.servers?.[targetName];
  if (!targetProfile) return;
  if (resolveIdentityFromConfig(targetProfile, targetName) !== 'brainrouter') return;

  for (const [id, profile] of Object.entries(ctx.config.servers ?? {})) {
    if (id === targetName) continue;
    if (resolveIdentityFromConfig(profile, id) !== 'brainrouter') continue;
    const status = ctx.mcpClient.getStatus(id);
    if (status?.status === 'connected' || status?.status === 'connecting') {
      await ctx.mcpClient.disconnectOne(id);
    }
  }
}

function activateBrainrouterProfile(ctx: CommandContext, targetName: string): boolean {
  const status = ctx.mcpClient.getStatus(targetName);
  const profile = ctx.config.servers?.[targetName];
  const isBrainrouter =
    status?.identity === 'brainrouter' ||
    (profile ? resolveIdentityFromConfig(profile, targetName) === 'brainrouter' : false);
  if (!isBrainrouter) return false;
  ctx.config.activeServer = targetName;
  saveConfig(ctx.config);
  return true;
}

function printRefreshedBanner(ctx: CommandContext): void {
  const theme = resolveTheme(ctx.agent.workspaceRoot);
  const banner = renderBanner(buildBannerInputs(ctx.config, ctx.agent, ctx.mcpClient), theme);
  if (ctx.repl.replaceBanner) {
    ctx.repl.replaceBanner('\n' + banner);
  } else {
    console.log(chalk.gray('Updated active BrainRouter banner:'));
    console.log(banner);
    console.log();
  }
}
