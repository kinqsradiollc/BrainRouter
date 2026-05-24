/**
 * 0.3.6 item 11: `/mcp` slash-command surface. Scope-limited foundation —
 * the full multi-MCP federation (parallel cross-MCP tool calls, MCP
 * marketplace, capability tiers) is deferred to 0.4.0. What ships here:
 *
 *   /mcp           — show status of the active MCP (alias for /mcp list)
 *   /mcp list      — list every configured profile with identity + status
 *   /mcp reconnect — reconnect the currently-active profile
 *   /mcp tools     — list MCP tools grouped by namespace (pre-Item-11
 *                    `/mcp` no-arg behaviour, moved here verbatim)
 *
 * The reconnect path leans on `mcpClient.close()` + `mcpClient.connect()`
 * with the same config the CLI launched against — no plumbing required
 * for the user beyond typing the command.
 */

import chalk from 'chalk';
import { spinner as makeSpinner } from '../spinner.js';
import type { CommandContext } from './_context.js';

export async function tryHandleMcpCommand(ctx: CommandContext): Promise<boolean> {
  const { command, args, mcpClient, config } = ctx;
  if (command !== '/mcp') return false;

  const sub = (args[0] ?? 'list').toLowerCase();

  if (sub === 'tools') {
    // Pre-Item-11 `/mcp` no-arg behaviour: namespace-grouped tool listing.
    // Kept verbatim under a subcommand so the muscle memory survives.
    const profileName = config.activeServer;
    const server = config.servers[profileName];
    console.log(chalk.bold('\nMCP server'));
    console.log(`  Profile: ${chalk.green(profileName)} (${chalk.cyan(server?.type ?? 'unknown')})`);
    if (server?.type === 'http') {
      console.log(`  URL:     ${chalk.blue(server.url ?? '')}`);
    } else if (server?.type === 'stdio') {
      console.log(`  Cmd:     ${chalk.blue(server.command ?? '')} ${server.args?.join(' ') || ''}`);
    }
    const spinner = makeSpinner(chalk.gray('Fetching MCP tool surface...')).start();
    try {
      const res = await mcpClient.listTools();
      const tools = res.tools || [];
      spinner.succeed(chalk.green(`${tools.length} MCP tools available`));
      const namespaces: Record<string, string[]> = {};
      for (const t of tools) {
        const parts = (t.name || '').split('_');
        const ns = parts.length > 1 ? parts[0] : 'misc';
        (namespaces[ns] ||= []).push(t.name);
      }
      for (const ns of Object.keys(namespaces).sort()) {
        console.log(`\n  ${chalk.bold.cyan(ns)} (${namespaces[ns].length})`);
        for (const name of namespaces[ns].sort()) {
          console.log(`    ${chalk.gray('•')} ${name}`);
        }
      }
    } catch (err: any) {
      spinner.fail(chalk.red(`Failed: ${err.message}`));
    }
    console.log();
    return true;
  }

  if (sub === 'list') {
    const activeName = config.activeServer;
    const profiles = Object.keys(config.servers ?? {});
    if (profiles.length === 0) {
      console.log(chalk.yellow('\nNo MCP profiles configured. Run `brainrouter login` or `brainrouter config` to set one up.\n'));
      return true;
    }
    console.log(chalk.bold('\nConfigured MCP profiles'));
    for (const name of profiles) {
      const profile = config.servers[name];
      const isActive = name === activeName;
      // Identity: explicit config field > live wrapper > 'unknown'.
      let identity: string = profile.identity ?? 'unknown';
      if (isActive && typeof (mcpClient as any).getIdentity === 'function') {
        identity = (mcpClient as any).getIdentity();
      }
      const onlineLabel = isActive
        ? (mcpClient.isConnected() ? chalk.green('online') : chalk.red('offline'))
        : chalk.gray('idle');
      const idLabel = identity === 'brainrouter'
        ? chalk.cyan('brainrouter')
        : identity === 'third-party'
          ? chalk.yellow('third-party')
          : chalk.gray('unknown');
      const marker = isActive ? chalk.bold('★ ') : '  ';
      const transport = profile.type;
      const target = profile.type === 'http' ? profile.url ?? '<no url>' : profile.command ?? '<no command>';
      console.log(`${marker}${chalk.bold(name)}  ${idLabel}  ${transport}  ${onlineLabel}  ${chalk.gray(target)}`);
    }
    console.log(chalk.gray('\n★ = active profile.  /mcp reconnect to refresh the active connection.\n'));
    return true;
  }

  if (sub === 'reconnect') {
    const activeName = config.activeServer;
    const profile = config.servers?.[activeName];
    if (!profile) {
      console.log(chalk.red(`\nNo active MCP profile to reconnect (\`activeServer\` = ${JSON.stringify(activeName)}).\n`));
      return true;
    }
    console.log(chalk.gray(`Reconnecting "${activeName}"…`));
    try {
      try { await mcpClient.close(); } catch { /* idempotent */ }
      await mcpClient.connect(profile, config.llm, activeName);
      // Re-probe tools so identity tagging and the prompt's tool list refresh.
      try { await mcpClient.listTools(); } catch { /* tool-list failure is non-fatal */ }
      console.log(chalk.green(`✓ Reconnected to "${activeName}" (${profile.type}).\n`));
    } catch (err: any) {
      console.log(chalk.red(`✗ Reconnect failed: ${err?.message ?? err}\n`));
      console.log(chalk.gray('The CLI stays in offline mode. Check the MCP server, then try `/mcp reconnect` again.\n'));
    }
    return true;
  }

  console.log(chalk.red(`\nUnknown /mcp subcommand "${sub}". Usage: /mcp list | /mcp reconnect | /mcp tools\n`));
  return true;
}
