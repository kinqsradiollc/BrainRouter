// Cross-cutting helpers shared by the /config sub-modules (home panel, per-row
// editors, key handlers). Extracted from the former single-file config command
// so the pieces can import a common base without cycling through each other.
import type { CommandContext } from '../_context.js';
import { saveConfig, type LLMConfig } from '@kinqs/brainrouter-core/config';
import { setAgentModel } from '@kinqs/brainrouter-core/provider';
import { readPreferences } from '@kinqs/brainrouter-core/session';
import { runPicker, runTextField } from '../../ink/runPicker.js';
import { buildTheme, type Theme } from '../../theme/theme.js';

export const pickFromList = runPicker;
export const promptText = runTextField;

export type { LLMConfig };

// --- word lists for on/off knob parsing --------------------------------
export const TRUE_WORDS = ['on', 'true', '1', 'yes'];
export const FALSE_WORDS = ['off', 'false', '0', 'no'];

// --- get / set handler shape (shared by keyHandlers) -------------------
export type SetResult = { ok: true; message: string } | { ok: false; reason: string };

export interface ConfigKeyHandler {
  get: (ctx: CommandContext) => string;
  set?: (ctx: CommandContext, value: string) => SetResult | Promise<SetResult>;
}

export function themeFor(ctx: CommandContext): Theme {
  const mode = readPreferences(ctx.agent.workspaceRoot).theme;
  return buildTheme(mode === 'mono' ? 'mono' : mode === 'light' ? 'light' : 'dark');
}

export function shortenEndpoint(url?: string): string {
  if (!url) return 'default endpoint';
  return url.replace(/^https?:\/\//, '').replace(/\/v1.*$/, '').replace(/\/api\/v1.*$/, '');
}

export function findDefaultProviderName(ctx: CommandContext): string | undefined {
  const llm = ctx.config.llm;
  if (!llm) return undefined;
  return Object.entries(ctx.config.providers ?? {}).find(([, p]) =>
    p.provider === llm.provider &&
    p.model === llm.model &&
    (p.endpoint ?? '') === (llm.endpoint ?? '') &&
    p.apiKey === llm.apiKey
  )?.[0];
}

export function setDefaultProvider(ctx: CommandContext, name: string): boolean {
  const provider = ctx.config.providers?.[name];
  if (!provider) return false;
  ctx.config.llm = { ...provider };
  const fallback = ctx.config.agentModels?.default;
  const fallbackDuplicatesMain =
    !!fallback &&
    (
      (fallback.provider === name && (!fallback.model || fallback.model === provider.model)) ||
      (!fallback.provider && (!fallback.model || fallback.model === provider.model))
    );
  if (fallbackDuplicatesMain) ctx.config = setAgentModel(ctx.config, 'default', {});
  saveConfig(ctx.config);
  ctx.agent.setLLMConfig(provider);
  return true;
}

export function subagentRoleLabel(role: string): string {
  return role === 'default' ? 'Fallback for sub-agents' : role;
}

export function setAgentModelNormalized(ctx: CommandContext, role: string, provider: string | undefined, model: string): boolean {
  const defaultProvider = findDefaultProviderName(ctx);
  const providerCfg = provider ? ctx.config.providers?.[provider] : undefined;
  const duplicatesMain =
    (!provider && (!model || model === ctx.config.llm?.model)) ||
    (!!provider && provider === defaultProvider && (!model || model === providerCfg?.model));
  ctx.config = setAgentModel(ctx.config, role, duplicatesMain ? {} : { provider, model });
  saveConfig(ctx.config);
  return duplicatesMain;
}

export function parseKeyValueLines(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\n|;/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function formatKeyValueLines(values?: Record<string, string>): string {
  return values ? Object.entries(values).map(([k, v]) => `${k}=${v}`).join('; ') : '';
}

export function ensureWebSearchConfig(ctx: CommandContext): NonNullable<NonNullable<CommandContext['config']['cli']>['webSearch']> {
  ctx.config.cli = ctx.config.cli ?? {};
  ctx.config.cli.webSearch = ctx.config.cli.webSearch ?? {};
  return ctx.config.cli.webSearch;
}
