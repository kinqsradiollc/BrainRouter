import chalk from 'chalk';
import type { CommandContext } from '../_context.js';
import {
  configSchemaFields,
  findConfigSchemaField,
  getConfigValueAtPath,
  saveConfig,
  setConfigValueAtPath,
  _resetCliKnobsCache,
  type ConfigSchemaField,
  type ConfigSchemaSection,
} from '@kinqs/brainrouter-core/config';
import { pickFromList, promptText, themeFor, TRUE_WORDS, FALSE_WORDS, type ConfigKeyHandler, type SetResult } from './shared.js';

export interface SchemaPanelRow {
  key: string;
  label: string;
  current: () => string;
  edit: (ctx: CommandContext) => Promise<boolean>;
}

export function formatSchemaValue(field: ConfigSchemaField, value: unknown): string {
  const effective = value === undefined ? field.defaultValue : value;
  if (effective === null || effective === undefined || effective === '') return '(provider default)';
  if (typeof effective === 'boolean') return effective ? 'on' : 'off';
  return String(effective);
}

export function parseSchemaValue(field: ConfigSchemaField, raw: string): SetResult & { value?: unknown } {
  const value = raw.trim();
  if (value === '') return { ok: true, message: `${field.path} cleared`, value: null };
  if (field.type === 'boolean') {
    const normalized = value.toLowerCase();
    if (TRUE_WORDS.includes(normalized)) return { ok: true, message: `${field.path} → on`, value: true };
    if (FALSE_WORDS.includes(normalized)) return { ok: true, message: `${field.path} → off`, value: false };
    return { ok: false, reason: `${field.path} must be on|off` };
  }
  if (field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, reason: `${field.path} must be a number` };
    if (field.min !== undefined && n < field.min) return { ok: false, reason: `${field.path} must be >= ${field.min}` };
    if (field.max !== undefined && n > field.max) return { ok: false, reason: `${field.path} must be <= ${field.max}` };
    return { ok: true, message: `${field.path} → ${n}`, value: n };
  }
  if (field.type === 'select') {
    if (!field.options?.includes(value)) return { ok: false, reason: `${field.path} must be one of: ${(field.options ?? []).join('|')}` };
    return { ok: true, message: `${field.path} → ${value}`, value };
  }
  return { ok: true, message: `${field.path} → ${value}`, value };
}

export function schemaKeyHandler(field: ConfigSchemaField): ConfigKeyHandler {
  return {
    get: (ctx) => formatSchemaValue(field, getConfigValueAtPath(ctx.config.cli as Record<string, unknown> | undefined, field.path)),
    set: (ctx, raw) => {
      const parsed = parseSchemaValue(field, raw);
      if (!parsed.ok) return parsed;
      ctx.config.cli = ctx.config.cli ?? {};
      setConfigValueAtPath(ctx.config.cli as Record<string, unknown>, field.path, parsed.value);
      saveConfig(ctx.config);
      _resetCliKnobsCache();
      return { ok: true, message: parsed.message };
    },
  };
}

export function schemaHandlerForKey(key: string): ConfigKeyHandler | undefined {
  const normalized = key.startsWith('cli.') ? key.slice(4) : key;
  const field = findConfigSchemaField(normalized);
  return field ? schemaKeyHandler(field) : undefined;
}

export function buildSchemaPanelRows(ctx: CommandContext, sections: ConfigSchemaSection[]): SchemaPanelRow[] {
  const cli = ctx.config.cli as Record<string, unknown> | undefined;
  return sections.flatMap((section) => configSchemaFields(section).map((field) => ({
    key: `schema:${field.path}`,
    label: field.label,
    current: () => formatSchemaValue(field, getConfigValueAtPath(cli, field.path)),
    edit: (nextCtx) => editSchemaField(nextCtx, field),
  })));
}

async function editSchemaField(ctx: CommandContext, field: ConfigSchemaField): Promise<boolean> {
  const theme = themeFor(ctx);
  const current = getConfigValueAtPath(ctx.config.cli as Record<string, unknown> | undefined, field.path);
  if (field.type === 'boolean' || field.type === 'select') {
    const options = field.type === 'boolean' ? ['on', 'off'] : field.options ?? [];
    const picked = await pickFromList({
      theme,
      title: field.label,
      subtitle: field.description,
      rows: options.map((id) => ({ id, label: id, value: id === formatSchemaValue(field, current) ? 'current' : '' })),
      initialCursor: Math.max(0, options.indexOf(formatSchemaValue(field, current))),
    });
    if (picked.kind !== 'pick') return false;
    const result = await schemaKeyHandler(field).set!(ctx, picked.id);
    if (!result.ok) {
      console.log(chalk.red(`\n  ${result.reason}\n`));
      return false;
    }
    console.log(chalk.green(`\n  ${result.message}\n`));
    return true;
  }
  const entered = await promptText({
    theme,
    title: field.label,
    subtitle: field.description,
    badge: field.path,
    prefilled: current === undefined || current === null ? '' : String(current),
    placeholder: field.defaultValue === null || field.defaultValue === undefined ? '(blank = default)' : String(field.defaultValue),
    validate: (raw) => {
      const parsed = parseSchemaValue(field, raw);
      return parsed.ok ? undefined : parsed.reason;
    },
  });
  if (entered.kind !== 'accept') return false;
  const result = await schemaKeyHandler(field).set!(ctx, entered.text);
  if (!result.ok) {
    console.log(chalk.red(`\n  ${result.reason}\n`));
    return false;
  }
  console.log(chalk.green(`\n  ${result.message}\n`));
  return true;
}
