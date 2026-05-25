import chalk from 'chalk';
import type { CommandContext } from './_context.js';
import { saveConfig, type ServerConfig } from '../../config/config.js';
import { McpClientWrapper } from '../../runtime/mcpClient.js';
import { maskApiKey } from '../wizard/providers.js';
// 0.3.7 — picker / prompt moved to Ink (see commands/config.ts for the
// full rationale on why the raw-stdout primitives were retired).
import { runPicker, runTextField } from '../ink/runPicker.js';
const pickFromList = runPicker;
const promptText = runTextField;
import { buildTheme, type Theme } from '../theme.js';
import { readPreferences } from '../../state/preferencesStore.js';
import { editLlm } from './config.js';

/**
 * `/login` slash command — 0.3.7 redesign on the new internal picker.
 *
 * Opens a small modal that picks a transport (stdio / local-http /
 * remote-http), gathers fields via the framed text prompt, runs a
 * single 5s reachability probe, and saves the profile. Probe failure
 * offers "save anyway / try a different transport / cancel".
 *
 * The legacy `brainrouter login` subcommand stays for users who
 * scripted it.
 */
export async function tryHandleLoginCommand(ctx: CommandContext): Promise<boolean> {
  if (ctx.command !== '/login') return false;
  const theme = buildTheme(readPreferences(ctx.agent.workspaceRoot).theme === 'mono' ? 'mono' : readPreferences(ctx.agent.workspaceRoot).theme === 'light' ? 'light' : 'dark');

  while (true) {
    const transport = await pickFromList({
      theme,
      title: '/login — MCP profile',
      subtitle: 'Pick how this CLI reaches the BrainRouter MCP.',
      rows: [
        { id: 'local-stdio', label: 'Local stdio', value: 'brainrouter-mcp', description: 'No HTTP server needed' },
        { id: 'local-http',  label: 'Local HTTP',  value: 'localhost:3747', description: 'Connect to a brainrouter-mcp HTTP server running locally' },
        { id: 'remote-http', label: 'Remote HTTP', value: 'custom URL',     description: 'Hosted MCP server (URL + optional key)' },
      ],
    });
    if (transport.kind !== 'pick') {
      console.log(chalk.yellow('\n  /login cancelled.\n'));
      return true;
    }

    let serverConfig: ServerConfig | undefined;
    let profileName = '';
    if (transport.id === 'local-stdio') {
      serverConfig = { type: 'stdio', command: 'brainrouter-mcp', args: [], identity: 'brainrouter' };
      profileName = 'local-stdio';
    } else if (transport.id === 'local-http') {
      serverConfig = { type: 'http', url: 'http://localhost:3747/mcp', identity: 'brainrouter' };
      profileName = 'local-http';
    } else {
      const urlResult = await promptText({
        theme,
        title: 'Remote MCP URL',
        subtitle: 'Paste the full URL (e.g. https://brainrouter.example.com/mcp).',
        prefilled: '',
        placeholder: 'https://...',
        validate: (raw) => {
          const v = raw.trim();
          if (!v) return 'URL required';
          try { new URL(v); } catch { return 'not a valid URL'; }
          return undefined;
        },
      });
      if (urlResult.kind !== 'accept') {
        console.log(chalk.yellow('\n  /login cancelled.\n'));
        return true;
      }
      const url = urlResult.text.trim();
      const keyResult = await promptText({
        theme,
        title: 'API key (optional)',
        subtitle: 'Press ENTER to skip — only some MCP servers require a key.',
        prefilled: '',
        placeholder: '(none)',
      });
      const apiKey = keyResult.kind === 'accept' ? keyResult.text.trim() : '';
      serverConfig = { type: 'http', url, apiKey: apiKey || undefined, identity: 'brainrouter' };
      profileName = 'remote';
    }

    const probe = await probeMcpProfile(serverConfig, profileName);
    if (!probe.ok) {
      const choice = await pickFromList({
        theme,
        title: 'MCP probe failed',
        subtitle: probe.error,
        rows: [
          { id: 'save',  label: 'Save anyway',           description: 'Persist the profile; run /mcp reconnect once the server is up' },
          { id: 'retry', label: 'Try a different transport', description: 'Re-open the picker' },
          { id: 'cancel', label: 'Cancel',               description: 'Discard — nothing written' },
        ],
      });
      if (choice.kind !== 'pick' || choice.id === 'cancel') {
        console.log(chalk.yellow('\n  /login cancelled.\n'));
        return true;
      }
      if (choice.id === 'retry') continue;
    } else {
      console.log(chalk.green(`\n  ✓ Probe succeeded (${probe.latencyMs}ms).`));
    }

    ctx.config.servers[profileName] = serverConfig;
    ctx.config.activeServer = profileName;
    saveConfig(ctx.config);
    const apiKeyDisplay = serverConfig.apiKey ? maskApiKey(serverConfig.apiKey) : '(no key)';
    console.log(chalk.green(`  ✓ MCP profile "${profileName}" saved as active. ${apiKeyDisplay}`));
    console.log(chalk.gray('    Run /mcp reconnect to pick up the new transport without restarting.\n'));

    // 0.3.7 — follow-on LLM credential step. Pre-0.3.7 `/login`
    // *only* handled the MCP profile; users who wanted to refresh
    // their LLM API key in the same flow had to bounce out to
    // `/config` or `/init`. Now we offer it inline.
    //
    // Always offer (per user direction); default-No when LLM
    // creds are already populated, default-Yes when missing.
    const hasLlm = Boolean(ctx.config.llm?.apiKey?.trim()) && Boolean(ctx.config.llm?.endpoint);
    const promptSubtitle = hasLlm
      ? `Current: ${ctx.config.llm?.model ?? '(unset)'} @ ${ctx.config.llm?.endpoint ?? '(no endpoint)'} · key ${maskApiKey(ctx.config.llm?.apiKey ?? '')}`
      : 'No LLM credentials saved yet — set them now so the next turn works.';
    const llmChoice = await pickFromList({
      theme,
      title: 'Update LLM credentials?',
      subtitle: promptSubtitle,
      rows: hasLlm ? [
        { id: 'skip',   label: 'Skip — keep current LLM config', description: 'Press ENTER to exit /login' },
        { id: 'update', label: 'Update LLM',                     description: 'Switch provider / paste a new key / change model' },
      ] : [
        { id: 'update', label: 'Set LLM now',                    description: 'Provider → API key → Model' },
        { id: 'skip',   label: 'Skip — set up later via /config', description: 'Exit /login without LLM config' },
      ],
      initialCursor: 0,
    });
    if (llmChoice.kind === 'pick' && llmChoice.id === 'update') {
      const ok = await editLlm(ctx);
      if (!ok) {
        console.log(chalk.yellow('  /login — LLM step cancelled; MCP profile saved.\n'));
      }
    }
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
