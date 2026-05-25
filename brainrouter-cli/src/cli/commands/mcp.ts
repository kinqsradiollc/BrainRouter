/**
 * `/mcp` slash-command surface. 0.3.7 multi-MCP rewrite — every
 * configured server is connected concurrently on boot and the
 * command now lists / reconnects / connects / disconnects per
 * server rather than touching a singleton.
 *
 *   /mcp                    — alias for /mcp list
 *   /mcp list               — every configured profile + per-server status
 *   /mcp tools [server]     — MCP tools grouped by `mcp__<server>__*`
 *                             namespace; pass a server id to scope
 *   /mcp connect <name>     — connect a configured server that's idle/offline
 *   /mcp disconnect <name>  — close one server's transport (config preserved)
 *   /mcp reconnect [name]   — reconnect ONE (when name given) or ALL configured
 *
 * Backwards-compat: `/mcp reconnect` with no arg used to reconnect the
 * single "active" profile; with the pool we now reconnect every server
 * the pool knows about. Pass an explicit name to target one.
 */

import chalk from 'chalk';
import { spinner as makeSpinner } from '../spinner.js';
import type { CommandContext } from './_context.js';

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
      // Pool tools are exposed as `mcp__<serverId>__<rawTool>`. Group by serverId.
      const byServer: Record<string, string[]> = {};
      for (const t of allTools) {
        const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(t.name);
        const serverId = m?.[1] ?? '__unknown__';
        const raw = m?.[2] ?? t.name;
        if (onlyServer && serverId !== onlyServer) continue;
        (byServer[serverId] ||= []).push(raw);
      }
      const serverIds = Object.keys(byServer).sort();
      if (serverIds.length === 0) {
        console.log(chalk.gray(`\n  No tools for server "${onlyServer}".\n`));
        return true;
      }
      for (const id of serverIds) {
        const ident = mcpClient.getStatus(id)?.identity ?? 'unknown';
        const identTag =
          ident === 'brainrouter' ? chalk.cyan('brainrouter') :
          ident === 'third-party' ? chalk.yellow('third-party') :
          chalk.gray('unknown');
        console.log(`\n  ${chalk.bold.green(id)} ${identTag} (${byServer[id].length})`);
        for (const name of byServer[id].sort()) {
          console.log(`    ${chalk.gray('•')} ${name}  ${chalk.gray(`mcp__${id}__${name}`)}`);
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
    for (const name of profiles) {
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
      const idLabel =
        identity === 'brainrouter' ? chalk.cyan('brainrouter') :
        identity === 'third-party' ? chalk.yellow('third-party') :
        chalk.gray('unknown');
      const marker = name === activeName ? chalk.bold('★ ') : '  ';
      const transport = profile.type;
      const target = profile.type === 'http' ? profile.url ?? '<no url>' : profile.command ?? '<no command>';
      const toolTag = poolStatus?.toolCount != null ? chalk.gray(`${poolStatus.toolCount} tools`) : '';
      const errTag = liveStatus === 'failed' && poolStatus?.error ? chalk.red(` · ${poolStatus.error}`) : '';
      console.log(`${marker}${chalk.bold(name)}  ${idLabel}  ${transport}  ${statusLabel}  ${chalk.gray(target)}  ${toolTag}${errTag}`);
    }
    console.log(chalk.gray('\n★ = highlighted profile in the banner.'));
    console.log(chalk.gray('  Multi-MCP: every configured server connects on boot. Use /mcp connect|disconnect|reconnect <name> to manage.\n'));
    return true;
  }

  if (sub === 'reconnect') {
    if (!targetName) {
      // No name → reconnect every configured server in the pool.
      const ids = Object.keys(config.servers ?? {});
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
      await mcpClient.reconnectOne(targetName);
      const s = mcpClient.getStatus(targetName);
      if (s?.status === 'connected') {
        console.log(chalk.green(`✓ Reconnected to "${targetName}".\n`));
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
      await mcpClient.connectOne(targetName, profile, config.llm, 5_000);
      const s = mcpClient.getStatus(targetName);
      if (s?.status === 'connected') {
        console.log(chalk.green(`✓ "${targetName}" online (${s.toolCount ?? 0} tools).\n`));
      } else {
        console.log(chalk.red(`✗ "${targetName}" failed — ${s?.error ?? 'unknown'}\n`));
      }
    } catch (err: any) {
      console.log(chalk.red(`✗ Connect failed: ${err?.message ?? err}\n`));
    }
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

  console.log(chalk.red(`\nUnknown /mcp subcommand "${sub}". Usage: /mcp list | /mcp tools [server] | /mcp connect <name> | /mcp disconnect <name> | /mcp reconnect [name]\n`));
  return true;
}
