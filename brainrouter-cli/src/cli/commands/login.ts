import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { askChoice, CancelledChoiceError } from '../cliPrompt.js';
import { saveConfig, type ServerConfig } from '../../config/config.js';
import { McpClientWrapper } from '../../runtime/mcpClient.js';
import { maskApiKey } from '../wizard/providers.js';

/**
 * `/login` slash command — 0.3.7.
 *
 * In-REPL alternative to `brainrouter login`. Opens a small modal that
 * picks a transport (stdio / local-http / remote-http), gathers the
 * fields via the picker's "Other" fallback, runs a single reachability
 * probe (5s timeout), and saves the profile.
 *
 * Why duplicate `brainrouter login`? The legacy subcommand is great
 * for a fresh install (no REPL yet), but once the user is inside the
 * REPL the workflow used to be "exit → run `brainrouter login` →
 * re-enter REPL → /mcp reconnect." Three context switches for what
 * should be one panel. The new slash command collapses the loop.
 *
 * `brainrouter login` (subcommand) stays for back-compat; users who
 * scripted it don't break.
 */
export async function tryHandleLoginCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/login') return false;
  try {
    const transport = await askChoice(
      'Pick an MCP transport:',
      [
        { label: 'Local stdio', description: 'Spawn `brainrouter-mcp` on $PATH' },
        { label: 'Local HTTP', description: 'http://localhost:3747/mcp' },
        { label: 'Remote HTTP', description: 'Hosted BrainRouter URL (key optional)' },
      ],
      { header: '/login' },
    );

    let serverConfig: ServerConfig | undefined;
    let profileName = '';
    if (transport === 'Local stdio') {
      serverConfig = { type: 'stdio', command: 'brainrouter-mcp', args: [], identity: 'brainrouter' };
      profileName = 'local-stdio';
    } else if (transport === 'Local HTTP') {
      serverConfig = { type: 'http', url: 'http://localhost:3747/mcp', identity: 'brainrouter' };
      profileName = 'local-http';
    } else {
      // Remote HTTP — prompt for URL + optional API key. Empty key OK.
      const urlAnswer = await askChoice(
        'Remote BrainRouter MCP URL:',
        [{ label: 'http://localhost:3747/mcp', description: 'default' }],
        { header: 'URL', prefilledOther: '' },
      );
      const url = typeof urlAnswer === 'string' ? urlAnswer.trim() : '';
      if (!url) {
        console.log(chalk.yellow('\n  /login cancelled — no URL provided.\n'));
        return true;
      }
      try { new URL(url); } catch {
        console.log(chalk.red(`\n  ✗ "${url}" is not a valid URL.\n`));
        return true;
      }
      const keyAnswer = await askChoice(
        'API key (optional):',
        [{ label: 'No key (open server)', description: 'Skip — only for unauthenticated MCP servers' }],
        { header: 'API key', prefilledOther: '' },
      );
      const apiKey = typeof keyAnswer === 'string' && keyAnswer !== 'No key (open server)'
        ? keyAnswer.trim()
        : undefined;
      serverConfig = { type: 'http', url, apiKey: apiKey || undefined, identity: 'brainrouter' };
      profileName = 'remote';
    }
    if (!serverConfig) return true;

    // Probe.
    const probe = await probeMcpProfile(serverConfig, profileName);
    if (!probe.ok) {
      try {
        const choice = await askChoice(
          `MCP probe failed: ${probe.error}. Save anyway?`,
          [
            { label: 'Save anyway', description: 'Persist the profile; run /mcp reconnect once the server is up' },
            { label: 'Try a different transport', description: 'Re-open the picker' },
            { label: 'Cancel', description: 'Discard — nothing written' },
          ],
          { header: 'Probe failed' },
        );
        if (choice === 'Try a different transport') return tryHandleLoginCommand(ctx);
        if (choice !== 'Save anyway') {
          console.log(chalk.yellow('\n  /login cancelled.\n'));
          return true;
        }
      } catch (err) {
        if (err instanceof CancelledChoiceError) {
          console.log(chalk.yellow('\n  /login cancelled.\n'));
          return true;
        }
        throw err;
      }
    } else {
      console.log(chalk.green(`\n  ✓ Probe succeeded (${probe.latencyMs}ms).\n`));
    }

    ctx.config.servers[profileName] = serverConfig;
    ctx.config.activeServer = profileName;
    saveConfig(ctx.config);
    const apiKeyDisplay = serverConfig.apiKey ? maskApiKey(serverConfig.apiKey) : '(no key)';
    console.log(chalk.green(`  ✓ MCP profile "${profileName}" saved as active. ${apiKeyDisplay}\n`));
    console.log(chalk.gray('    Run /mcp reconnect to pick up the new transport without restarting.\n'));
    return true;
  } catch (err) {
    if (err instanceof CancelledChoiceError) {
      console.log(chalk.yellow('\n  /login cancelled.\n'));
      return true;
    }
    console.log(chalk.red(`\n  /login failed: ${(err as Error)?.message ?? err}\n`));
    return true;
  }
}

async function probeMcpProfile(serverConfig: ServerConfig, name: string): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const wrapper = new McpClientWrapper();
  const start = Date.now();
  try {
    await Promise.race([
      wrapper.connect(serverConfig, undefined, name),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timed out after 5s')), 5_000)),
    ]);
    await wrapper.close();
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    try { await wrapper.close(); } catch { /* ignore */ }
    return { ok: false, error: String(err?.message ?? err) };
  }
}
