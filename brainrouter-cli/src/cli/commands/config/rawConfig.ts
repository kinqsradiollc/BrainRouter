// Raw-config dump + secret scrubbing for `/config raw` and the "View raw config"
// panel row. buildScrubbedConfigJson is the single chokepoint that masks every
// api key / auth header before config JSON is shown.
import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import { getConfigPath } from '@kinqs/brainrouter-core/config';
import { maskApiKey } from '@kinqs/brainrouter-core/provider';
import type { Theme } from '../../theme/theme.js';
import { pickFromList } from './shared.js';
import {
  containsObviousCredentialValue,
  isSensitiveCredentialName,
  redactMcpHttpUrl,
  redactMcpStdioArgs,
} from '../../mcpUrl.js';

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

function scrubSecrets(scrubbed: unknown): void {
  scrubValue(scrubbed, []);
}

function scrubValue(value: unknown, path: string[]): unknown {
  if (isMcpCredentialMap(path)) return scrubEveryString(value);
  if (isMcpStdioArgs(path) && Array.isArray(value)) return scrubStdioArgs(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = scrubValue(value[index], [...path, String(index)]);
    }
    return value;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      record[key] = isSecretFieldName(key)
        ? scrubSecretValue(child)
        : scrubValue(child, [...path, key]);
    }
    return record;
  }

  return typeof value === 'string' ? scrubPotentialCredential(value) : value;
}

function isMcpCredentialMap(path: string[]): boolean {
  return path.length === 3
    && path[0] === 'servers'
    && (path[2] === 'env' || path[2] === 'headers');
}

function isMcpStdioArgs(path: string[]): boolean {
  return path.length === 3 && path[0] === 'servers' && path[2] === 'args';
}

function isSecretFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Credential file locations are useful diagnostics and are not credentials.
  if (normalized.endsWith('path') || normalized.endsWith('file') || normalized.endsWith('filename')) {
    return false;
  }
  return normalized === 'servekey' || isSensitiveCredentialName(key);
}

function scrubSecretValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  return typeof value === 'string' ? maskApiKey(value) : '[redacted]';
}

function scrubEveryString(value: unknown): unknown {
  if (typeof value === 'string') return maskApiKey(value);
  if (Array.isArray(value)) return value.map((entry) => scrubEveryString(entry));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      record[key] = scrubEveryString(child);
    }
  }
  return value;
}

function scrubStdioArgs(args: unknown[]): unknown[] {
  const redacted = redactMcpStdioArgs(args.map((argument) =>
    typeof argument === 'string' ? argument : ''));
  return args.map((argument, index) =>
    typeof argument === 'string' ? redacted[index] : argument);
}

function scrubPotentialCredential(value: string): string {
  if (/^https?:\/\//i.test(value)) return redactMcpHttpUrl(value);
  if (/\bBearer\s+\S+/i.test(value) || containsObviousCredentialValue(value)) {
    return maskApiKey(value);
  }
  return value;
}
