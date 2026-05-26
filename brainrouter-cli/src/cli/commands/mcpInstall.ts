/**
 * `/mcp install` — generates per-vendor MCP config snippets for non-CLI
 * hosts (Claude Desktop, Cursor, Windsurf, VS Code Continue, Zed, Cline).
 *
 * Pattern: print-only. We do NOT write to vendor config files — the user
 * pastes the block themselves. Direct-write is a future enhancement
 * (roadmap: tracked under post-0.4.0 polish; intentionally not a follow-up).
 *
 * Adapted from semble's per-agent install docs pattern
 * (openSrc/semble/src/semble/agents/) — one focused entry per vendor.
 */

import chalk from 'chalk';
import type { Config } from '../../config/config.js';
import { displayPath, getVendor, listVendors, renderSnippet, VENDORS } from '../../runtime/vendorSnippets.js';

export interface RenderResult {
  ok: boolean;
  output: string;
}

export interface RunOpts {
  platform?: NodeJS.Platform;
}

/**
 * Resolve the active BrainRouter profile from config. Returns null when
 * the user hasn't logged in yet — caller prints a `/login` hint.
 */
function resolveActiveBrainrouter(config: Config): { url: string; apiKey: string } | null {
  const name = config.activeServer;
  if (!name) return null;
  const profile = config.servers?.[name];
  if (!profile) return null;
  if (profile.type !== 'http') return null;
  const url = profile.url?.trim();
  const apiKey = profile.apiKey?.trim();
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

export function runMcpInstall(args: string[], config: Config, opts: RunOpts = {}): RenderResult {
  const platform = opts.platform ?? process.platform;
  const sub = (args[0] ?? '').toLowerCase();

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    return {
      ok: true,
      output:
        `${chalk.bold('Usage')}\n` +
        `  /mcp install list           — list supported vendors\n` +
        `  /mcp install <vendor>       — print paste-ready snippet for one vendor\n\n` +
        `Vendors: ${listVendors().map((v) => v.id).join(', ')}\n`,
    };
  }

  if (sub === 'list') {
    const lines: string[] = [chalk.bold('\nSupported MCP hosts')];
    for (const v of listVendors()) {
      const p = displayPath(v.configPath(platform), platform);
      lines.push(`  ${chalk.bold.cyan(v.id.padEnd(18))} ${chalk.gray(v.label.padEnd(28))} ${chalk.gray(p)}`);
    }
    lines.push(
      '',
      chalk.gray(`Run "/mcp install <id>" for a paste-ready snippet.`),
      '',
    );
    return { ok: true, output: lines.join('\n') };
  }

  const entry = getVendor(sub);
  if (!entry) {
    return {
      ok: false,
      output:
        chalk.red(`\nUnknown vendor "${sub}".\n`) +
        chalk.gray(`Known: ${Object.keys(VENDORS).join(', ')}\n`),
    };
  }

  const active = resolveActiveBrainrouter(config);
  if (!active) {
    return {
      ok: false,
      output:
        chalk.red('\nNo active BrainRouter profile with URL + API key.\n') +
        chalk.gray('Run `/login` to configure one, then re-run this command.\n'),
    };
  }

  const snippet = renderSnippet(entry, { url: active.url, apiKey: active.apiKey });
  const configPath = displayPath(entry.configPath(platform), platform);

  const out: string[] = [];
  out.push('');
  out.push(chalk.bold.cyan(`${entry.label}  (${entry.id})`));
  out.push(chalk.gray(`Config file: ${configPath}`));
  if (entry.note) out.push(chalk.gray(`Note:        ${entry.note}`));
  out.push('');
  out.push(chalk.yellow('⚠  This block contains your live API key — paste into your vendor config and do not commit.'));
  out.push('');
  out.push(snippet);
  out.push('');
  out.push(chalk.gray(`Restart: ${entry.restart}`));
  out.push(chalk.gray('Web reference: brainrouter-docs/mcp-install.md'));
  out.push('');

  return { ok: true, output: out.join('\n') };
}
