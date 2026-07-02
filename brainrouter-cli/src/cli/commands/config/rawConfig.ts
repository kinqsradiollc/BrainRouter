// Raw-config dump + secret scrubbing for `/config raw` and the "View raw config"
// panel row. buildScrubbedConfigJson is the single chokepoint that masks every
// api key / auth header before config JSON is shown.
import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { getConfigPath } from '@kinqs/brainrouter-core/config';
import { maskApiKey } from '@kinqs/brainrouter-core/provider';
import type { Theme } from '../../theme.js';
import { pickFromList } from './shared.js';

export async function showRawConfigPanel(ctx: CommandContext, theme: Theme): Promise<void> {
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

export function printRawConfig(ctx: CommandContext): void {
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
  if (scrubbed.cli?.webSearch) {
    if (scrubbed.cli.webSearch.serperApiKey) scrubbed.cli.webSearch.serperApiKey = maskApiKey(scrubbed.cli.webSearch.serperApiKey);
    if (scrubbed.cli.webSearch.braveApiKey) scrubbed.cli.webSearch.braveApiKey = maskApiKey(scrubbed.cli.webSearch.braveApiKey);
    if (scrubbed.cli.webSearch.google?.apiKey) scrubbed.cli.webSearch.google.apiKey = maskApiKey(scrubbed.cli.webSearch.google.apiKey);
  }
  // Named provider keys (multi-provider routing) — these were NOT masked before,
  // so `/config show` leaked every saved provider's api key.
  for (const p of Object.values(scrubbed.providers ?? {})) {
    const prov = p as any;
    if (prov?.apiKey) prov.apiKey = maskApiKey(prov.apiKey);
  }
  for (const s of Object.values(scrubbed.servers ?? {})) {
    const srv = s as any;
    if (srv.apiKey) srv.apiKey = maskApiKey(srv.apiKey);
    if (srv.env?.BRAINROUTER_API_KEY) srv.env.BRAINROUTER_API_KEY = maskApiKey(srv.env.BRAINROUTER_API_KEY);
    // Custom auth headers on an MCP server profile (Authorization / x-api-key / …).
    if (srv.headers && typeof srv.headers === 'object') {
      for (const k of Object.keys(srv.headers)) {
        if (/authorization|api[-_]?key|token|secret|cookie/i.test(k) && typeof srv.headers[k] === 'string') {
          srv.headers[k] = maskApiKey(srv.headers[k]);
        }
      }
    }
  }
}
